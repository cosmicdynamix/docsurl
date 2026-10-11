import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadSessionUser } from '../auth.js';
import { config } from '../config.js';
import { ipHash, randomToken } from '../crypto.js';
import { clientIp, purgeExpired, secureCookie } from '../net.js';
import { pool } from '../db.js';
import { verifyPassword } from '../passwords.js';
import { slugSchema } from '../slug.js';
import { parseUA } from '../ua.js';
import { ogPath, pagePath } from '../storage.js';
import { notFoundPage, unlockPage, viewerPage } from '../viewer.js';
import { baseUrl } from './links.js';

// Link-preview fetchers and crawlers. Do NOT match bare app names ("LinkedIn", "WhatsApp"...): real in-app browsers carry them.
const BOT_RE = /bot|crawl|spider|preview|facebookexternalhit|facebot|whatsapp\/\d|embedly|vkshare|skypeuripreview|curl|wget|headless|python-requests|go-http-client|httpclient/i;
const IMG_TTL_S = 3600;
const ACCESS_TTL_S = 12 * 3600;

const hmac = (data: string): string => createHmac('sha256', config.appSecret).update(data).digest('base64url');
const safeEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const accessCookie = (linkId: string): string => `docs_acc_${linkId.slice(0, 8)}`;
const accessSig = (l: { id: string; password_hash: string }, exp: number): string =>
  hmac(`acc:${l.id}:${l.password_hash.slice(-16)}:${exp}`);
const imgSig = (linkId: string, versionNo: number, exp: number): string => hmac(`img:${linkId}:${versionNo}:${exp}`);

// Wrong-password throttle: 8 failures / 15 min per ip+slug.
const unlockFails = new Map<string, { n: number; until: number }>();
const unlockLocked = (k: string): boolean => {
  const f = unlockFails.get(k);
  if (!f) return false;
  if (Date.now() > f.until) {
    unlockFails.delete(k);
    return false;
  }
  return f.n >= 8;
};

interface PublicLink {
  id: string;
  slug: string;
  kind: 'file' | 'url';
  title: string;
  destination_url: string | null;
  password_hash: string | null;
  owner_id: string;
  version_id: string | null;
  version_no: number | null;
  active: boolean;
}

async function findLink(slug: string): Promise<PublicLink | null> {
  const { rows } = await pool.query<PublicLink>(
    `select l.id, l.slug, l.kind, l.title, l.destination_url, l.password_hash, l.owner_id,
            cv.id as version_id, cv.version_no,
            (l.status = 'active'
             and (l.expires_at is null or l.expires_at > now())
             and (l.max_views is null or (select count(*) from views v where v.link_id = l.id and not v.is_bot and not v.is_owner_preview) < l.max_views)) as active
       from links l left join link_versions cv on cv.id = l.current_version_id
      where l.slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

function csp(reply: FastifyReply, nonce: string): void {
  reply.header(
    'Content-Security-Policy',
    `default-src 'none'; img-src 'self' data:; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  reply.header('Cache-Control', 'no-store');
}

function html(reply: FastifyReply, status: number, body: string) {
  return reply.code(status).type('text/html; charset=utf-8').send(body);
}

const VID_COOKIE = 'docs_vid';

async function recordView(req: FastifyRequest, reply: FastifyReply, link: PublicLink): Promise<number> {
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 400);
  const h = (name: string) => {
    const v = req.headers[name];
    return typeof v === 'string' && v ? v.slice(0, 100) : null;
  };
  const num = (name: string) => {
    const v = Number(h(name));
    return Number.isFinite(v) && h(name) ? v : null;
  };
  const referer = typeof req.headers.referer === 'string' ? req.headers.referer.slice(0, 500) : null;
  let refHost: string | null = null;
  try {
    refHost = referer ? new URL(referer).host : null;
  } catch {
    /* malformed referer */
  }
  const src = (req.query as { src?: string }).src;
  const user = await loadSessionUser(req).catch(() => null);
  const ownerPreview = !!user && (user.role === 'admin' || user.id === link.owner_id);
  const isBot = BOT_RE.test(ua);
  const parsed = parseUA(ua);

  // First-party random visitor id (no personal data) to count unique/returning visitors.
  let vid: string | null = null;
  if (!isBot) {
    vid = req.cookies[VID_COOKIE] ?? null;
    if (!vid || !/^[\w-]{8,40}$/.test(vid)) {
      vid = randomToken(12);
      reply.setCookie(VID_COOKIE, vid, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie(req),
        maxAge: 365 * 86400,
      });
    }
  }

  const { rows } = await pool.query<{ id: string }>(
    `insert into views(link_id, version_id, ip_hash, country, region, city, latitude, longitude, timezone, user_agent,
                       referrer_url, referrer_host, src_tag, is_bot, is_owner_preview, visitor_id,
                       browser, browser_ver, os, os_ver, device_type, in_app, lang)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) returning id`,
    [
      link.id, link.version_id, ipHash(clientIp(req)), h('cf-ipcountry'), h('cf-region'), h('cf-ipcity'),
      num('cf-iplatitude'), num('cf-iplongitude'), h('cf-timezone'), ua, referer, refHost,
      typeof src === 'string' && src ? src.slice(0, 64) : null, isBot, ownerPreview, vid,
      parsed.browser, parsed.browserVer, parsed.os, parsed.osVer, parsed.device, parsed.inApp,
      (h('accept-language') ?? '').split(',')[0].slice(0, 20) || null,
    ],
  );
  return Number(rows[0].id);
}

const trkSig = (viewId: number): string => hmac(`trk:${viewId}`);

const MAX_DWELL_MS = 6 * 3600_000;
const trackSchema = z.object({
  t: z.string(),
  a: z.number().int().min(0).max(MAX_DWELL_MS * 4),
  o: z.number().int().min(0).max(86_400_000),
  p: z.number().int().min(0).max(1000),
  d: z.record(z.string(), z.number().int().min(0).max(MAX_DWELL_MS)).default({}),
  w: z.number().int().min(0).max(20000).optional(),
  h: z.number().int().min(0).max(20000).optional(),
  l: z.string().max(20).optional(),
});

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  // Engagement beacon from the viewer: cumulative totals, so repeated/lost beacons are harmless.
  app.post(
    '/_t/:viewId',
    { bodyLimit: 8192, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const viewId = Number((req.params as { viewId: string }).viewId);
      const body = trackSchema.safeParse(req.body);
      if (!Number.isInteger(viewId) || viewId <= 0 || !body.success) return reply.code(400).send();
      const d = body.data;
      if (!safeEq(d.t, trkSig(viewId))) return reply.code(403).send();

      const { rows } = await pool.query<{ page_count: number | null }>(
        `select cv.page_count from views v left join link_versions cv on cv.id = v.version_id
          where v.id = $1 and v.started_at > now() - interval '24 hours'`,
        [viewId],
      );
      if (!rows[0]) return reply.code(204).send();
      const pageCount = rows[0].page_count ?? 0;

      const pages: number[] = [];
      const dwell: number[] = [];
      for (const [k, v] of Object.entries(d.d)) {
        const n = Number(k);
        if (Number.isInteger(n) && n >= 1 && (!pageCount || n <= pageCount)) {
          pages.push(n);
          dwell.push(v);
        }
      }
      const maxPage = pageCount ? Math.min(d.p, pageCount) : d.p;
      await pool.query(
        `update views set
           active_ms = greatest(coalesce(active_ms, 0), $2), open_ms = greatest(coalesce(open_ms, 0), $3),
           max_page = greatest(coalesce(max_page, 0), $4), last_heartbeat_at = now(), ended_at = now(),
           lang = coalesce($5, lang), screen_w = coalesce(screen_w, $6), screen_h = coalesce(screen_h, $7)
         where id = $1`,
        [viewId, d.a, d.o, maxPage, d.l ?? null, d.w || null, d.h || null],
      );
      if (pages.length) {
        await pool.query(
          `insert into view_pages(view_id, page_no, dwell_ms)
           select $1, k, v from unnest($2::int[], $3::int[]) as t(k, v)
           on conflict (view_id, page_no) do update set dwell_ms = greatest(view_pages.dwell_ms, excluded.dwell_ms)`,
          [viewId, pages, dwell],
        );
        await pool.query(
          `update views set top_dwell_page =
             (select page_no from view_pages where view_id = $1 order by dwell_ms desc, page_no limit 1) where id = $1`,
          [viewId],
        );
      }
      return reply.code(204).send();
    },
  );

  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.get('/favicon.ico', async (_req, reply) => reply.redirect('/app/brand/icon-dark.svg'));

  // Link preview image (first page, small). Not offered for password-protected links.
  app.get('/_og/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file.replace(/\.jpg$/, '');
    const slug = slugSchema.safeParse(file);
    if (!slug.success) return reply.code(404).send();
    const link = await findLink(slug.data);
    if (!link || !link.active || link.kind !== 'file' || link.password_hash || !link.version_no) return reply.code(404).send();
    try {
      await access(ogPath(link.id, link.version_no));
    } catch {
      return reply.code(404).send();
    }
    return reply.header('Cache-Control', 'public, max-age=300').type('image/jpeg').send(createReadStream(ogPath(link.id, link.version_no)));
  });

  // Page images: signed, short-lived URLs embedded in the viewer HTML.
  app.get(
    '/_p/:linkId/:ver/:n',
    { config: { rateLimit: { max: 2000, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const p = z
        .object({ linkId: z.string().uuid(), ver: z.coerce.number().int().positive(), n: z.coerce.number().int().positive() })
        .safeParse(req.params);
      const q = z.object({ e: z.coerce.number().int(), t: z.string() }).safeParse(req.query);
      if (!p.success || !q.success) return reply.code(404).send();
      if (q.data.e < Date.now() / 1000 || !safeEq(q.data.t, imgSig(p.data.linkId, p.data.ver, q.data.e))) return reply.code(403).send();
      const file = pagePath(p.data.linkId, p.data.ver, p.data.n);
      try {
        await access(file);
      } catch {
        return reply.code(404).send();
      }
      return reply
        .header('Cache-Control', 'private, max-age=600')
        .header('Content-Disposition', 'inline')
        .type('image/jpeg')
        .send(createReadStream(file));
    },
  );

  app.post('/:slug/unlock', async (req, reply) => {
    const nonce = randomBytes(16).toString('base64');
    csp(reply, nonce);
    const slug = slugSchema.safeParse((req.params as { slug: string }).slug);
    if (!slug.success) return html(reply, 404, notFoundPage(nonce));
    const link = await findLink(slug.data);
    if (!link || !link.active || !link.password_hash) return html(reply, 404, notFoundPage(nonce));
    const key = `${clientIp(req)}|${link.id}`;
    if (unlockLocked(key)) return html(reply, 429, unlockPage({ slug: link.slug, title: link.title, error: true, nonce }));
    const pw = String((req.body as { password?: string } | undefined)?.password ?? '');
    if (!(await verifyPassword(link.password_hash, pw))) {
      purgeExpired(unlockFails);
      const f = unlockFails.get(key);
      if (!f || Date.now() > f.until) unlockFails.set(key, { n: 1, until: Date.now() + 15 * 60_000 });
      else f.n++;
      return html(reply, 401, unlockPage({ slug: link.slug, title: link.title, error: true, nonce }));
    }
    unlockFails.delete(key);
    const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_S;
    reply.setCookie(accessCookie(link.id), `${exp}.${accessSig({ id: link.id, password_hash: link.password_hash }, exp)}`, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie(req),
      maxAge: ACCESS_TTL_S,
    });
    return reply.code(303).header('Location', `/${link.slug}`).send();
  });

  app.get('/:slug', async (req, reply) => {
    const nonce = randomBytes(16).toString('base64');
    csp(reply, nonce);
    const slug = slugSchema.safeParse((req.params as { slug: string }).slug);
    if (!slug.success) return html(reply, 404, notFoundPage(nonce));
    const link = await findLink(slug.data);
    if (!link || !link.active) return html(reply, 404, notFoundPage(nonce));

    if (link.kind === 'url') {
      await recordView(req, reply, link);
      return reply.code(302).header('Location', link.destination_url!).send();
    }
    if (!link.version_no || !link.version_id) return html(reply, 404, notFoundPage(nonce));

    if (link.password_hash) {
      const c = req.cookies[accessCookie(link.id)];
      const [expStr, sig] = (c ?? '').split('.');
      const exp = Number(expStr);
      const ok = !!sig && exp > Date.now() / 1000 && safeEq(sig, accessSig({ id: link.id, password_hash: link.password_hash }, exp));
      if (!ok) return html(reply, 200, unlockPage({ slug: link.slug, title: link.title, nonce }));
    }

    const pages = (
      await pool.query<{ width: number; height: number }>(
        'select width, height from link_pages where version_id = $1 order by page_no',
        [link.version_id],
      )
    ).rows;
    const viewId = await recordView(req, reply, link);
    const exp = Math.floor(Date.now() / 1000) + IMG_TTL_S;
    const base = baseUrl(req);
    return html(
      reply,
      200,
      viewerPage({
        slug: link.slug,
        title: link.title,
        linkId: link.id,
        versionNo: link.version_no,
        pages,
        exp,
        sig: imgSig(link.id, link.version_no, exp),
        viewId,
        viewToken: trkSig(viewId),
        ogImage: link.password_hash ? null : `${base}/_og/${link.slug}.jpg`,
        pageUrl: `${base}/${link.slug}`,
        nonce,
      }),
    );
  });
}

