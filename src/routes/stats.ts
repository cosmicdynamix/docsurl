import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { pool } from '../db.js';
import { sourceLabel } from '../ua.js';

const idParam = z.object({ id: z.string().uuid() });
const flag = z.enum(['0', '1']).optional();
const querySchema = z.object({
  range: z.enum(['24h', '7d', '30d', '90d', 'all']).default('30d'),
  tz: z.string().max(64).optional(),
  bots: flag,
  owner: flag,
  version: z.string().refine((v) => v === 'all' || /^[0-9a-f-]{36}$/i.test(v)).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const RANGE_MS: Record<string, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 };

let tzCache: Set<string> | null = null;
async function safeTz(tz?: string): Promise<string> {
  if (!tz) return 'UTC';
  if (!tzCache) {
    const { rows } = await pool.query<{ name: string }>('select name from pg_timezone_names');
    tzCache = new Set(rows.map((r) => r.name));
  }
  return tzCache.has(tz) ? tz : 'UTC';
}

/** Optional per-version filter fragment (uuid is validated by the query schema). */
const versionSql = (version?: string, alias = 'v'): string =>
  version && version !== 'all' ? ` and ${alias}.version_id = '${version}'` : '';

function bounds(range: string): { from: Date; to: Date } {
  const to = new Date(Date.now() + 60_000);
  return { from: range === 'all' ? new Date(0) : new Date(Date.now() - RANGE_MS[range]), to };
}

/** Visitor key: first-party cookie id when present, else the hashed IP. */
const VISITOR = 'coalesce(v.visitor_id, v.ip_hash)';
/** Params: $1 link id, $2 from, $3 to, $4 include bots, $5 include owner views. */
const BASE_Q = 'v.link_id = $1 and v.started_at >= $2 and v.started_at < $3 and ($4::bool or not v.is_bot) and ($5::bool or not v.is_owner_preview)';

async function accessibleLink(req: FastifyRequest, reply: FastifyReply, id: string) {
  const { rows } = await pool.query<{ id: string; kind: string; owner_id: string; current_version_id: string | null; created_at: Date; title: string; slug: string }>(
    'select id, kind, owner_id, current_version_id, created_at, title, slug from links where id = $1',
    [id],
  );
  const link = rows[0];
  if (!link || (req.user!.role !== 'admin' && link.owner_id !== req.user!.id)) {
    reply.code(404).send({ error: 'not_found' });
    return null;
  }
  return link;
}

interface SourceRow {
  referrer_host: string | null;
  in_app: string | null;
  src_tag: string | null;
  views: number;
  visitors: number;
}
function mergeSources(rows: SourceRow[]): { name: string; views: number; visitors: number }[] {
  const m = new Map<string, { name: string; views: number; visitors: number }>();
  for (const r of rows) {
    const name = sourceLabel(r.referrer_host, r.in_app);
    const cur = m.get(name) ?? { name, views: 0, visitors: 0 };
    cur.views += r.views;
    cur.visitors += r.visitors; // upper bound when several hosts map to the same label
    m.set(name, cur);
  }
  return [...m.values()].sort((a, b) => b.views - a.views).slice(0, 15);
}

const SESSION_COLS = `s.id, s.started_at as "startedAt", s.country, s.region, s.city, s.browser, s.browser_ver as "browserVer",
  s.os, s.os_ver as "osVer", s.device_type as device, s.in_app as "inApp", s.referrer_url as "referrerUrl",
  s.referrer_host as "referrerHost", s.src_tag as "srcTag", s.active_ms as "activeMs", s.open_ms as "openMs",
  s.max_page as "maxPage", s.top_dwell_page as "topPage", s.is_bot as "isBot", s.is_owner_preview as "isOwner",
  s.page_count as "pageCount", s.lang, s.visitor, s.visit_no as "visitNo"`;

const sessionsSql = (extra = ""): string => `
  select ${SESSION_COLS} from (
    select v.*, cv.page_count, substr(md5(${VISITOR}), 1, 12) as visitor,
           row_number() over (partition by ${VISITOR} order by v.started_at)::int as visit_no
      from views v left join link_versions cv on cv.id = v.version_id
     where v.link_id = $1 and ($4::bool or not v.is_bot) and ($5::bool or not v.is_owner_preview)${extra}
  ) s where s.started_at >= $2 and s.started_at < $3
  order by s.started_at desc limit $6 offset $7`;

type SessionRow = Record<string, unknown> & { referrerHost: string | null; inApp: string | null };
const withSource = (r: SessionRow) => ({ ...r, source: r.srcTag ? `${sourceLabel(r.referrerHost, r.inApp)} · ${String(r.srcTag)}` : sourceLabel(r.referrerHost, r.inApp) });

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralize spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  /* ---------- per-link statistics ---------- */
  app.get('/api/links/:id/stats', { preHandler: requireAuth }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = querySchema.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid' });
    const link = await accessibleLink(req, reply, p.data.id);
    if (!link) return;

    const { from, to } = bounds(q.data.range);
    const tz = await safeTz(q.data.tz);
    const base = [link.id, from, to, q.data.bots === '1', q.data.owner === '1'];
    const BASE = BASE_Q + versionSql(q.data.version); // local, version-aware filter

    // Timeline start: for "all", the first view (max 365 days back).
    let tlFrom = from;
    if (q.data.range === 'all') {
      const first = (await pool.query<{ t: Date | null }>(`select min(v.started_at) as t from views v where ${BASE}`, base)).rows[0].t;
      const floor = new Date(Date.now() - 365 * 86_400_000);
      tlFrom = first ? (first < floor ? floor : first) : new Date(Date.now() - 29 * 86_400_000);
    }

    const group = (expr: string, extra = '') =>
      pool.query(
        `select ${expr} as name${extra}, count(*)::int as views, count(distinct ${VISITOR})::int as visitors
           from views v where ${BASE} group by ${expr}${extra ? ', ' + extra.slice(2) : ''} order by views desc, name limit 15`,
        base,
      );

    const version = q.data.version && q.data.version !== 'all' ? q.data.version : link.current_version_id;
    const byVersionQ = pool.query(
      `select cv.id, cv.version_no as "versionNo", cv.page_count as "pageCount", cv.uploaded_at as "uploadedAt", cv.note,
              cv.original_name as "originalName", (cv.id = l.current_version_id) as current,
              count(v.id)::int as views, count(distinct ${VISITOR})::int as visitors,
              coalesce(round(avg(v.active_ms)), 0)::int as "avgActiveMs",
              coalesce(avg(case when cv.page_count > 0 and v.max_page is not null then least(v.max_page::float / cv.page_count, 1) end), 0) as "avgDepth",
              count(v.id) filter (where cv.page_count > 0 and v.max_page >= cv.page_count)::int as completed
         from link_versions cv join links l on l.id = cv.link_id
         left join views v on v.version_id = cv.id and v.started_at >= $2 and v.started_at < $3
                          and ($4::bool or not v.is_bot) and ($5::bool or not v.is_owner_preview)
        where cv.link_id = $1 group by cv.id, l.current_version_id order by cv.version_no desc`,
      base,
    );
    const [summary, returning, timeline, countries, cities, browsers, oses, devices, sources, referrers, tags, langs, pages, byVersion] = await Promise.all([
      pool.query(
        `select count(*)::int as views, count(distinct ${VISITOR})::int as visitors,
                coalesce(round(avg(v.active_ms)), 0)::int as "avgActiveMs", coalesce(round(avg(v.open_ms)), 0)::int as "avgOpenMs",
                max(v.started_at) as "lastViewed",
                coalesce(avg(case when cv.page_count > 0 and v.max_page is not null then least(v.max_page::float / cv.page_count, 1) end), 0) as "avgDepth",
                count(*) filter (where cv.page_count > 0 and v.max_page >= cv.page_count)::int as completed,
                count(*) filter (where v.active_ms is not null)::int as measured
           from views v left join link_versions cv on cv.id = v.version_id where ${BASE}`,
        base,
      ),
      pool.query(
        `select count(*)::int as n from (select ${VISITOR} from views v where ${BASE} group by 1 having count(*) > 1) x`,
        base,
      ),
      pool.query(
        `select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(c.views, 0)::int as views, coalesce(c.visitors, 0)::int as visitors
           from generate_series(($2::timestamptz at time zone $6)::date, (($3::timestamptz - interval '1 second') at time zone $6)::date, interval '1 day') as d(day)
           left join (
             select (v.started_at at time zone $6)::date as day, count(*) as views, count(distinct ${VISITOR}) as visitors
               from views v where ${BASE} group by 1
           ) c on c.day = d.day::date order by d.day`,
        [link.id, tlFrom, to, base[3], base[4], tz],
      ),
      group(`coalesce(v.country, 'Unknown')`),
      pool.query(
        `select coalesce(v.city, 'Unknown') as name, coalesce(v.country, '') as country, count(*)::int as views, count(distinct ${VISITOR})::int as visitors
           from views v where ${BASE} group by 1, 2 order by views desc, name limit 15`,
        base,
      ),
      group(`coalesce(v.browser, 'Unknown')`),
      group(`coalesce(v.os, 'Unknown')`),
      group(`coalesce(v.device_type, 'Unknown')`),
      pool.query<SourceRow>(
        `select v.referrer_host, v.in_app, v.src_tag, count(*)::int as views, count(distinct ${VISITOR})::int as visitors
           from views v where ${BASE} group by 1, 2, 3`,
        base,
      ),
      pool.query(
        `select v.referrer_url as name, count(*)::int as views, count(distinct ${VISITOR})::int as visitors
           from views v where ${BASE} and v.referrer_url is not null group by 1 order by views desc limit 15`,
        base,
      ),
      pool.query(
        `select v.src_tag as name, count(*)::int as views, count(distinct ${VISITOR})::int as visitors
           from views v where ${BASE} and v.src_tag is not null group by 1 order by views desc limit 15`,
        base,
      ),
      group(`coalesce(v.lang, 'Unknown')`),
      link.kind === 'file' && version
        ? pool.query(
            `select g.n as "pageNo",
                    (select count(*) from views v where v.version_id = $6 and ${BASE} and v.max_page >= g.n)::int as reached,
                    coalesce((select round(avg(vp.dwell_ms)) from view_pages vp join views v on v.id = vp.view_id
                               where v.version_id = $6 and ${BASE} and vp.page_no = g.n), 0)::int as "avgDwellMs",
                    coalesce((select sum(vp.dwell_ms) from view_pages vp join views v on v.id = vp.view_id
                               where v.version_id = $6 and ${BASE} and vp.page_no = g.n), 0)::bigint as "totalDwellMs"
               from generate_series(1, (select page_count from link_versions where id = $6)) as g(n) order by g.n`,
            [...base, version],
          )
        : Promise.resolve({ rows: [] }),
      byVersionQ,
    ]);

    const pageRows = (pages.rows as { pageNo: number; reached: number; avgDwellMs: number; totalDwellMs: string }[]).map((r) => ({
      ...r,
      totalDwellMs: Number(r.totalDwellMs),
    }));
    const s = summary.rows[0];
    return {
      range: q.data.range,
      tz,
      versionId: version,
      summary: { ...s, avgDepth: Number(s.avgDepth), returningVisitors: returning.rows[0].n },
      timeline: timeline.rows,
      countries: countries.rows,
      cities: cities.rows,
      browsers: browsers.rows,
      oses: oses.rows,
      devices: devices.rows,
      languages: langs.rows,
      sources: mergeSources(sources.rows),
      referrers: referrers.rows,
      tags: tags.rows,
      pages: pageRows,
      byVersion: (byVersion.rows as { avgDepth: string }[]).map((r) => ({ ...r, avgDepth: Number(r.avgDepth) })),
    };
  });

  app.get('/api/links/:id/views', { preHandler: requireAuth }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = querySchema.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid' });
    const link = await accessibleLink(req, reply, p.data.id);
    if (!link) return;
    const { from, to } = bounds(q.data.range);
    const { rows } = await pool.query(sessionsSql(versionSql(q.data.version)), [link.id, from, to, q.data.bots === '1', q.data.owner === '1', q.data.limit, q.data.offset]);
    return { views: (rows as SessionRow[]).map(withSource) };
  });

  app.get('/api/links/:id/views.csv', { preHandler: requireAuth }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = querySchema.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid' });
    const link = await accessibleLink(req, reply, p.data.id);
    if (!link) return;
    const { from, to } = bounds(q.data.range);
    const { rows } = await pool.query(sessionsSql(versionSql(q.data.version)), [link.id, from, to, q.data.bots === '1', q.data.owner === '1', 10000, 0]);
    const cols = ['startedAt', 'visitor', 'visitNo', 'country', 'region', 'city', 'device', 'os', 'osVer', 'browser', 'browserVer', 'source', 'referrerUrl', 'srcTag', 'activeMs', 'openMs', 'maxPage', 'pageCount', 'topPage', 'lang', 'isBot', 'isOwner'];
    const lines = [cols.join(',')];
    for (const r of (rows as SessionRow[]).map(withSource)) lines.push(cols.map((c) => csvCell((r as Record<string, unknown>)[c])).join(','));
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${link.slug}-views.csv"`)
      .send(lines.join('\n') + '\n');
  });

  /* ---------- per-visitor statistics ---------- */
  const VKEY = `substr(md5(${VISITOR}), 1, 12)`;

  app.get('/api/links/:id/visitors', { preHandler: requireAuth }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = querySchema.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid' });
    const link = await accessibleLink(req, reply, p.data.id);
    if (!link) return;
    const { from, to } = bounds(q.data.range);
    const base = [link.id, from, to, q.data.bots === '1', q.data.owner === '1', q.data.limit, q.data.offset];
    const BASE = BASE_Q + versionSql(q.data.version);
    const { rows } = await pool.query(
      `with s as (
         select v.*, cv.page_count, ${VKEY} as vkey from views v left join link_versions cv on cv.id = v.version_id where ${BASE}
       ), agg as (
         select vkey, count(*)::int as visits, min(started_at) as "firstSeen", max(started_at) as "lastSeen",
                coalesce(sum(active_ms), 0)::bigint as "totalActiveMs", coalesce(round(avg(active_ms)), 0)::int as "avgActiveMs",
                coalesce(max(max_page), 0)::int as "deepestPage", coalesce(max(page_count), 0)::int as "pageCount",
                bool_and(is_bot) as "isBot"
           from s group by vkey
       ), last as (
         select distinct on (vkey) vkey, country, city, device_type as device, browser, browser_ver as "browserVer", os, os_ver as "osVer",
                in_app as "inApp", referrer_host as "referrerHost", src_tag as "srcTag"
           from s order by vkey, started_at desc
       )
       select agg.vkey as key, agg.visits, agg."firstSeen", agg."lastSeen", agg."totalActiveMs"::float8 as "totalActiveMs", agg."avgActiveMs", agg."deepestPage", agg."pageCount",
              agg."isBot", last.country, last.city, last.device, last.browser, last."browserVer", last.os, last."osVer", last."inApp", last."referrerHost", last."srcTag"
         from agg join last using (vkey) order by agg."lastSeen" desc limit $6 offset $7`,
      base,
    );
    return {
      visitors: (rows as (Record<string, unknown> & { referrerHost: string | null; inApp: string | null; srcTag: string | null })[]).map((r) => ({
        ...r,
        source: r.srcTag ? `${sourceLabel(r.referrerHost, r.inApp)} · ${r.srcTag}` : sourceLabel(r.referrerHost, r.inApp),
      })),
    };
  });

  app.get('/api/links/:id/visitors/:key', { preHandler: requireAuth }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), key: z.string().regex(/^[0-9a-f]{12}$/) }).safeParse(req.params);
    const q = querySchema.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid' });
    const link = await accessibleLink(req, reply, p.data.id);
    if (!link) return;
    const { from, to } = bounds(q.data.range);
    const bots = q.data.bots === '1';
    const owner = q.data.owner === '1';
    const vf = versionSql(q.data.version);
    const keyFilter = ` and ${VKEY} = '${p.data.key}'`;
    const BASE = BASE_Q + vf + keyFilter;
    const base = [link.id, from, to, bots, owner];

    const [summary, pages, visits] = await Promise.all([
      pool.query(
        `select count(*)::int as visits, min(v.started_at) as "firstSeen", max(v.started_at) as "lastSeen",
                coalesce(sum(v.active_ms), 0)::float8 as "totalActiveMs", coalesce(round(avg(v.active_ms)), 0)::int as "avgActiveMs",
                coalesce(max(v.max_page), 0)::int as "deepestPage", coalesce(max(cv.page_count), 0)::int as "pageCount",
                coalesce(avg(case when cv.page_count > 0 and v.max_page is not null then least(v.max_page::float / cv.page_count, 1) end), 0) as "avgDepth"
           from views v left join link_versions cv on cv.id = v.version_id where ${BASE}`,
        base,
      ),
      pool.query(
        `select vp.page_no as "pageNo", sum(vp.dwell_ms)::float8 as "totalDwellMs", count(distinct vp.view_id)::int as "visitsWithPage"
           from view_pages vp join views v on v.id = vp.view_id where ${BASE} group by vp.page_no order by vp.page_no`,
        base,
      ),
      pool.query(sessionsSql(vf + keyFilter), [link.id, from, to, bots, owner, 200, 0]),
    ]);
    if (!summary.rows[0] || !summary.rows[0].visits) return reply.code(404).send({ error: 'not_found' });
    return {
      summary: { ...summary.rows[0], avgDepth: Number(summary.rows[0].avgDepth) },
      pages: pages.rows,
      visits: (visits.rows as SessionRow[]).map(withSource),
    };
  });

  /* ---------- overview across links (own links; admins see everything) ---------- */
  app.get('/api/stats/overview', { preHandler: requireAuth }, async (req, reply) => {
    const q = querySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid' });
    const admin = req.user!.role === 'admin';
    const tz = await safeTz(q.data.tz);
    const days = q.data.range === '24h' || q.data.range === '7d' ? 7 : q.data.range === '90d' ? 90 : 30;
    const from = new Date(Date.now() - days * 86_400_000);
    const to = new Date(Date.now() + 60_000);
    // $1 user id, $2 from, $3 to
    const scope = admin ? '$1::uuid is not null' : 'l.owner_id = $1';
    const BASE_O = `${scope} and v.started_at >= $2 and v.started_at < $3 and not v.is_bot and not v.is_owner_preview`;
    const base = [req.user!.id, from, to];

    const [totals, timeline, topLinks, countries, sourcesRaw, devices, recent, byUser] = await Promise.all([
      pool.query(
        `select (select count(*)::int from views v join links l on l.id = v.link_id where ${scope} and not v.is_bot and not v.is_owner_preview) as "viewsAll",
                count(*)::int as views, count(distinct ${VISITOR})::int as visitors,
                coalesce(round(avg(v.active_ms)), 0)::int as "avgActiveMs",
                coalesce(avg(case when cv.page_count > 0 and v.max_page is not null then least(v.max_page::float / cv.page_count, 1) end), 0) as "avgDepth",
                (select count(*)::int from links l where ${scope}) as links
           from views v join links l on l.id = v.link_id left join link_versions cv on cv.id = v.version_id where ${BASE_O}`,
        base,
      ),
      pool.query(
        `select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(c.views, 0)::int as views, coalesce(c.visitors, 0)::int as visitors
           from generate_series(($2::timestamptz at time zone $4)::date, (($3::timestamptz - interval '1 second') at time zone $4)::date, interval '1 day') as d(day)
           left join (
             select (v.started_at at time zone $4)::date as day, count(*) as views, count(distinct ${VISITOR}) as visitors
               from views v join links l on l.id = v.link_id where ${BASE_O} group by 1
           ) c on c.day = d.day::date order by d.day`,
        [...base, tz],
      ),
      pool.query(
        `select l.id, l.title, l.slug, l.recipient, l.kind, count(*)::int as views, count(distinct ${VISITOR})::int as visitors,
                coalesce(round(avg(v.active_ms)), 0)::int as "avgActiveMs", max(v.started_at) as "lastViewed"
           from views v join links l on l.id = v.link_id where ${BASE_O} group by l.id order by views desc, l.title limit 10`,
        base,
      ),
      pool.query(
        `select coalesce(v.country, 'Unknown') as name, count(*)::int as views, count(distinct ${VISITOR})::int as visitors
           from views v join links l on l.id = v.link_id where ${BASE_O} group by 1 order by views desc limit 10`,
        base,
      ),
      pool.query<SourceRow>(
        `select v.referrer_host, v.in_app, v.src_tag, count(*)::int as views, count(distinct ${VISITOR})::int as visitors
           from views v join links l on l.id = v.link_id where ${BASE_O} group by 1, 2, 3`,
        base,
      ),
      pool.query(
        `select coalesce(v.device_type, 'Unknown') as name, count(*)::int as views, count(distinct ${VISITOR})::int as visitors
           from views v join links l on l.id = v.link_id where ${BASE_O} group by 1 order by views desc`,
        base,
      ),
      pool.query(
        `select v.id, v.started_at as "startedAt", l.id as "linkId", l.title, l.recipient, v.country, v.city, v.browser, v.os,
                v.device_type as device, v.in_app as "inApp", v.referrer_host as "referrerHost", v.src_tag as "srcTag",
                v.active_ms as "activeMs", v.max_page as "maxPage", cv.page_count as "pageCount"
           from views v join links l on l.id = v.link_id left join link_versions cv on cv.id = v.version_id
          where ${scope} and not v.is_bot and not v.is_owner_preview order by v.started_at desc limit 15`,
        [req.user!.id],
      ),
      admin
        ? pool.query(
            `select u.email, u.display_name as "displayName",
                    (select count(*)::int from links l where l.owner_id = u.id) as links,
                    (select count(*)::int from views v join links l on l.id = v.link_id
                      where l.owner_id = u.id and v.started_at >= $1 and not v.is_bot and not v.is_owner_preview) as views
               from users u order by views desc, u.email limit 20`,
            [from],
          )
        : Promise.resolve({ rows: [] }),
    ]);

    const t = totals.rows[0];
    return {
      days,
      tz,
      totals: { ...t, avgDepth: Number(t.avgDepth) },
      timeline: timeline.rows,
      topLinks: topLinks.rows,
      countries: countries.rows,
      sources: mergeSources(sourcesRaw.rows),
      devices: devices.rows,
      recent: (recent.rows as SessionRow[]).map(withSource),
      byUser: byUser.rows,
    };
  });
}
