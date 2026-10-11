import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from './api';

/* ---------- formatting helpers ---------- */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const fmtNum = (n: number) => n.toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const when = (s: string) => new Date(s).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code === 'Unknown' ? 'Unknown' : code;
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/* ---------- types ---------- */
interface Row {
  name: string;
  views: number;
  visitors: number;
  country?: string;
}
interface Session {
  id: number;
  startedAt: string;
  country: string | null;
  city: string | null;
  browser: string | null;
  browserVer: string | null;
  os: string | null;
  osVer: string | null;
  device: string | null;
  source: string;
  referrerUrl: string | null;
  srcTag: string | null;
  activeMs: number | null;
  openMs: number | null;
  maxPage: number | null;
  pageCount: number | null;
  topPage: number | null;
  isBot?: boolean;
  isOwner?: boolean;
  visitor?: string;
  visitNo?: number;
  variant?: string;
  title?: string;
  recipient?: string | null;
  linkId?: string;
  linkKind?: string;
}

/* ---------- small chart components (pure SVG, theme-aware) ---------- */
function TimelineChart({ data }: { data: { day: string; views: number; visitors: number }[] }) {
  const W = 600;
  const H = 150;
  const pad = { l: 28, r: 6, t: 8, b: 20 };
  const max = Math.max(1, ...data.map((d) => d.views));
  const niceMax = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const bw = (W - pad.l - pad.r) / Math.max(1, data.length);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / niceMax);
  const step = Math.ceil(data.length / 6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Views per day" style={{ display: 'block' }}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={W - pad.r} y1={y(niceMax * f)} y2={y(niceMax * f)} stroke="var(--border)" strokeWidth="1" />
          <text x={pad.l - 4} y={y(niceMax * f) + 3} textAnchor="end" fontSize="9" fill="var(--muted)">
            {Math.round(niceMax * f)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const x = pad.l + i * bw;
        const h = H - pad.b - y(d.views);
        return (
          <g key={d.day}>
            <rect x={x + bw * 0.15} y={y(d.views)} width={Math.max(1, bw * 0.7)} height={Math.max(d.views ? 1.5 : 0, h)} rx="2" fill="var(--accent)">
              <title>{`${d.day}: ${d.views} views, ${d.visitors} visitors`}</title>
            </rect>
            {i % step === 0 && (
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--muted)">
                {d.day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Bars({ rows, label, empty = 'No data yet.' }: { rows: Row[]; label?: (r: Row) => string; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={`${r.name}|${r.country ?? ''}`}>
          <div className="bar-label" title={label ? label(r) : r.name}>
            {label ? label(r) : r.name}
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${Math.max(2, (r.views / max) * 100)}%` }} />
          </div>
          <div className="bar-val num">{fmtNum(r.views)}</div>
        </div>
      ))}
    </div>
  );
}

function PagesChart({ pages, totalViews }: { pages: { pageNo: number; reached: number; avgDwellMs: number; totalDwellMs: number }[]; totalViews: number }) {
  if (!pages.length) return <p className="muted">No page data yet.</p>;
  const maxDwell = Math.max(1, ...pages.map((p) => p.avgDwellMs));
  const top = [...pages].sort((a, b) => b.totalDwellMs - a.totalDwellMs)[0];
  return (
    <>
      {top && top.totalDwellMs > 0 && (
        <p>
          Most attention: <b>page {top.pageNo}</b> ({fmtDuration(top.avgDwellMs)} on average per view).
        </p>
      )}
      <div className="pages">
        {pages.map((p) => (
          <div className="pg-row" key={p.pageNo}>
            <div className="pg-no num">{p.pageNo}</div>
            <div className="pg-bars">
              <div className="bar-track" title={`${p.reached} of ${totalViews} views reached this page`}>
                <div className="bar-fill reach" style={{ width: `${totalViews ? (p.reached / totalViews) * 100 : 0}%` }} />
              </div>
              <div className="bar-track thin" title={`Average time on page: ${fmtDuration(p.avgDwellMs)}`}>
                <div className="bar-fill dwell" style={{ width: `${(p.avgDwellMs / maxDwell) * 100}%` }} />
              </div>
            </div>
            <div className="pg-val num">
              {totalViews ? pct(p.reached / totalViews) : '—'}
              <span className="muted"> · {fmtDuration(p.avgDwellMs)}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Top bar: share of views that reached the page. Bottom bar: average active time on the page.
      </p>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {sub && <div className="stat-sub muted">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function SessionCard({ s, showLink, linkId, urlKind }: { s: Session; showLink?: boolean; linkId?: string; urlKind?: boolean }) {
  // Short URLs redirect immediately, so there is no reading time or page data to show.
  const isUrl = urlKind || s.linkKind === 'url';
  const place = [s.city && s.city !== 'Unknown' ? s.city : null, s.country ? countryName(s.country) : null].filter(Boolean).join(', ') || 'Unknown location';
  const dev = [s.device, [s.browser, s.browserVer].filter(Boolean).join(' '), [s.os, s.osVer].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  return (
    <div className="audit-row">
      <div className="row between">
        <span>
          <b>{place}</b>
          {showLink && s.title && (
            <>
              {' '}
              <span className="muted">→</span>{' '}
              <Link to={`/links/${s.linkId}/stats`}>{s.title}</Link>
              {s.recipient && <span className="muted"> ({s.recipient})</span>}
            </>
          )}
        </span>
        <span className="muted num" style={{ fontSize: '0.8rem' }}>
          {when(s.startedAt)}
        </span>
      </div>
      <div className="muted" style={{ fontSize: '0.85rem' }}>
        {dev || 'Unknown device'}
      </div>
      <div className="row num" style={{ fontSize: '0.85rem', gap: 6 }}>
        <span className="badge">{s.source}</span>
        {s.variant === 'mobile' ? <span className="badge">Mobile PDF</span> : null}
        {linkId && s.visitor ? (
          <Link to={`/links/${linkId}/visitors/${s.visitor}`}>
            <span className="badge">Visitor {s.visitor.slice(0, 6)}</span>
          </Link>
        ) : null}
        {s.visitNo === undefined ? null : s.visitNo > 1 ? <span className="badge ok">Returning #{s.visitNo}</span> : <span className="badge">New visitor</span>}
        {s.isBot && <span className="badge off">Bot</span>}
        {s.isOwner && <span className="badge">You</span>}
        {!isUrl && (
          <>
            <span>
              Active <b>{fmtDuration(s.activeMs)}</b>
            </span>
            <span className="muted">· open {fmtDuration(s.openMs)}</span>
            {s.maxPage ? (
              <span className="muted">
                · reached page {s.maxPage}
                {s.pageCount ? `/${s.pageCount}` : ''}
              </span>
            ) : null}
            {s.topPage ? <span className="muted">· longest on page {s.topPage}</span> : null}
          </>
        )}
      </div>
      {s.referrerUrl && (
        <div className="muted" style={{ fontSize: '0.78rem', wordBreak: 'break-all' }}>
          from {s.referrerUrl}
        </div>
      )}
    </div>
  );
}

const RANGES: [string, string][] = [
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];

function RangePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="seg" role="group" aria-label="Time range">
      {RANGES.map(([k, l]) => (
        <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/* ---------- per-link stats page ---------- */
interface LinkStatsData {
  summary: {
    views: number;
    visitors: number;
    returningVisitors: number;
    avgActiveMs: number;
    avgOpenMs: number;
    lastViewed: string | null;
    avgDepth: number;
    completed: number;
    measured: number;
  };
  timeline: { day: string; views: number; visitors: number }[];
  countries: Row[];
  cities: Row[];
  browsers: Row[];
  oses: Row[];
  devices: Row[];
  languages: Row[];
  layouts: Row[];
  pageVariant: string;
  sources: Row[];
  referrers: Row[];
  tags: Row[];
  pages: { pageNo: number; reached: number; avgDwellMs: number; totalDwellMs: number }[];
  byVersion: { id: string; versionNo: number; pageCount: number; uploadedAt: string; note: string | null; originalName: string | null; current: boolean; views: number; visitors: number; avgActiveMs: number; avgDepth: number; completed: number }[];
}

interface VisitorRow {
  key: string;
  visits: number;
  firstSeen: string;
  lastSeen: string;
  totalActiveMs: number;
  avgActiveMs: number;
  deepestPage: number;
  pageCount: number;
  isBot: boolean;
  country: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  browserVer: string | null;
  os: string | null;
  osVer: string | null;
  source: string;
}

export function LinkStats() {
  const { id } = useParams();
  const [version, setVersion] = useState('all');
  const [pageVariant, setPageVariant] = useState<'desktop' | 'mobile'>('desktop');
  const [versionList, setVersionList] = useState<{ id: string; versionNo: number; current: boolean }[]>([]);
  const [visitors, setVisitors] = useState<VisitorRow[]>([]);
  const [range, setRange] = useState('30d');
  const [bots, setBots] = useState(false);
  const [owner, setOwner] = useState(false);
  const [link, setLink] = useState<{ title: string; recipient: string | null; kind: string; slug: string; pageCount: number | null } | null>(null);
  const [data, setData] = useState<LinkStatsData | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const qs = useMemo(
    () => `range=${range}&tz=${encodeURIComponent(tz())}&bots=${bots ? 1 : 0}&owner=${owner ? 1 : 0}${version !== 'all' ? `&version=${version}` : ''}&variant=${pageVariant}`,
    [range, bots, owner, version, pageVariant],
  );

  useEffect(() => {
    void api<{ link: any; versions: { id: string; versionNo: number; current: boolean }[] }>('GET', `/links/${id}`).then((r) => {
      setLink(r.link);
      setVersionList(r.versions);
    });
  }, [id]);
  useEffect(() => {
    setData(null);
    setSessions([]);
    setMore(true);
    void api<LinkStatsData>('GET', `/links/${id}/stats?${qs}`).then(setData);
    void api<{ visitors: VisitorRow[] }>('GET', `/links/${id}/visitors?${qs}&limit=50`).then((r) => setVisitors(r.visitors));
    void api<{ views: Session[] }>('GET', `/links/${id}/views?${qs}&limit=25&offset=0`).then((r) => {
      setSessions(r.views);
      setMore(r.views.length === 25);
    });
  }, [id, qs]);

  async function loadMore() {
    setLoading(true);
    const r = await api<{ views: Session[] }>('GET', `/links/${id}/views?${qs}&limit=25&offset=${sessions.length}`);
    setSessions([...sessions, ...r.views]);
    setMore(r.views.length === 25);
    setLoading(false);
  }

  const s = data?.summary;
  return (
    <>
      <div className="row between">
        <h1 style={{ wordBreak: 'break-word' }}>{link?.title ?? 'Stats'}</h1>
        <Link to={`/links/${id}`}>
          <button className="small">Settings</button>
        </Link>
      </div>
      {link?.recipient && (
        <p>
          <span className="muted">For: </span>
          <b>{link.recipient}</b>
        </p>
      )}
      <div className="stack" style={{ margin: '10px 0 14px' }}>
        <RangePicker value={range} onChange={setRange} />
        {versionList.length > 1 && (
          <select value={version} onChange={(e) => setVersion(e.target.value)} aria-label="File version">
            <option value="all">All versions</option>
            {versionList.map((v) => (
              <option key={v.id} value={v.id}>
                Version {v.versionNo}
                {v.current ? ' (live)' : ''}
              </option>
            ))}
          </select>
        )}
        <div className="row" style={{ gap: 16 }}>
          <label className="check">
            <input type="checkbox" checked={owner} onChange={(e) => setOwner(e.target.checked)} /> Include my own views
          </label>
          <label className="check">
            <input type="checkbox" checked={bots} onChange={(e) => setBots(e.target.checked)} /> Include bots and link previews
          </label>
        </div>
      </div>

      {!data && <p className="muted">Loading…</p>}
      {data && s && (
        <>
          <div className="stats-grid">
            <Stat label="Views" value={fmtNum(s.views)} sub={s.lastViewed ? `last ${when(s.lastViewed)}` : 'no views yet'} />
            <Stat label="Unique visitors" value={fmtNum(s.visitors)} sub={`${s.returningVisitors} returned`} />
            <Stat label="Avg. active time" value={fmtDuration(s.avgActiveMs)} sub={`open ${fmtDuration(s.avgOpenMs)} avg.`} />
            {link?.kind === 'file' && (
              <Stat label="Avg. depth" value={pct(s.avgDepth)} sub={`${s.completed} read to the end`} />
            )}
          </div>

          <Section title="Views over time">
            <TimelineChart data={data.timeline} />
          </Section>

          {link?.kind === 'file' && data.byVersion.length > 1 && (
            <Section title="By file version">
              {data.byVersion.map((v) => (
                <div className="audit-row" key={v.id}>
                  <div className="row between">
                    <b>
                      Version {v.versionNo} {v.current && <span className="badge ok">Live</span>}
                    </b>
                    <button className="small" onClick={() => setVersion(version === v.id ? 'all' : v.id)}>
                      {version === v.id ? 'Show all versions' : 'Show only this version'}
                    </button>
                  </div>
                  <div className="muted num" style={{ fontSize: '0.8rem' }}>
                    Uploaded {when(v.uploadedAt)} · {v.pageCount} pages{v.note ? ` · ${v.note}` : ''}
                  </div>
                  <div className="row num" style={{ fontSize: '0.88rem', gap: 14 }}>
                    <span>
                      <b>{fmtNum(v.views)}</b> <span className="muted">views</span>
                    </span>
                    <span>
                      <b>{fmtNum(v.visitors)}</b> <span className="muted">visitors</span>
                    </span>
                    <span>
                      <b>{fmtDuration(v.avgActiveMs)}</b> <span className="muted">avg. active</span>
                    </span>
                    <span>
                      <b>{pct(v.avgDepth)}</b> <span className="muted">avg. depth</span>
                    </span>
                    <span>
                      <b>{v.completed}</b> <span className="muted">read to end</span>
                    </span>
                  </div>
                </div>
              ))}
            </Section>
          )}

          <Section title="Visitors">
            {visitors.length === 0 && <p className="muted">No visitors in this range.</p>}
            {visitors.map((v) => (
              <div className="audit-row" key={v.key}>
                <div className="row between">
                  <span>
                    <Link to={`/links/${id}/visitors/${v.key}`}>
                      <b>Visitor {v.key.slice(0, 6)}</b>
                    </Link>{' '}
                    <span className="muted">
                      {[v.city && v.city !== 'Unknown' ? v.city : null, v.country ? countryName(v.country) : null].filter(Boolean).join(', ') || 'Unknown location'}
                    </span>
                    {v.isBot && <span className="badge off"> Bot</span>}
                  </span>
                  <span className="muted num" style={{ fontSize: '0.8rem' }}>
                    last {when(v.lastSeen)}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: '0.85rem' }}>
                  {[v.device, [v.browser, v.browserVer].filter(Boolean).join(' '), [v.os, v.osVer].filter(Boolean).join(' ')].filter(Boolean).join(' · ')} · {v.source}
                </div>
                <div className="row num" style={{ fontSize: '0.85rem', gap: 14 }}>
                  <span>
                    <b>{v.visits}</b> <span className="muted">{v.visits === 1 ? 'visit' : 'visits'}</span>
                  </span>
                  <span>
                    <b>{fmtDuration(v.totalActiveMs)}</b> <span className="muted">total active</span>
                  </span>
                  <span>
                    <b>{fmtDuration(v.avgActiveMs)}</b> <span className="muted">per visit</span>
                  </span>
                  {v.deepestPage > 0 && (
                    <span>
                      <span className="muted">reached page</span> <b>{v.deepestPage}</b>
                      {v.pageCount ? `/${v.pageCount}` : ''}
                    </span>
                  )}
                </div>
              </div>
            ))}
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Visitors are told apart by a random cookie in their browser, so the same person on two devices appears as two visitors.
            </p>
          </Section>

          {link?.kind === 'file' && (
            <Section title="Pages">
              {data.layouts.some((r) => r.name === 'mobile') && (
                <div className="seg" role="group" aria-label="Layout" style={{ marginBottom: 12 }}>
                  <button className={pageVariant === 'desktop' ? 'on' : ''} onClick={() => setPageVariant('desktop')}>
                    Desktop PDF
                  </button>
                  <button className={pageVariant === 'mobile' ? 'on' : ''} onClick={() => setPageVariant('mobile')}>
                    Mobile PDF
                  </button>
                </div>
              )}
              <PagesChart pages={data.pages} totalViews={data.layouts.find((r) => r.name === pageVariant)?.views ?? s.views} />
            </Section>
          )}

          <Section title="Where visitors came from">
            <Bars rows={data.sources} empty="No source data yet." />
            {data.tags.length > 0 && (
              <>
                <h3 style={{ marginTop: 14 }}>Source tags (?src=…)</h3>
                <Bars rows={data.tags} />
              </>
            )}
            {data.referrers.length > 0 && (
              <>
                <h3 style={{ marginTop: 14 }}>Referring pages</h3>
                <Bars rows={data.referrers} />
              </>
            )}
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Messaging apps and some browsers do not send a referrer. Add <code>?src=name</code> to a link to tell shares apart.
            </p>
          </Section>

          <Section title="Location">
            <Bars rows={data.countries} label={(r) => countryName(r.name)} empty="No location data yet (appears when the site runs behind Cloudflare)." />
            {data.cities.some((c) => c.name !== 'Unknown') && (
              <>
                <h3 style={{ marginTop: 14 }}>Cities</h3>
                <Bars rows={data.cities} label={(r) => `${r.name}${r.country ? `, ${r.country}` : ''}`} />
              </>
            )}
          </Section>

          <Section title="Devices and browsers">
            {data.layouts.length > 1 && (
              <>
                <h3>PDF layout shown</h3>
                <Bars rows={data.layouts.map((r) => ({ ...r, name: r.name === 'mobile' ? 'Mobile PDF' : 'Desktop PDF' }))} />
                <h3 style={{ marginTop: 14 }}>Device</h3>
              </>
            )}
            <h3>Device</h3>
            <Bars rows={data.devices} />
            <h3 style={{ marginTop: 14 }}>Browser</h3>
            <Bars rows={data.browsers} />
            <h3 style={{ marginTop: 14 }}>Operating system</h3>
            <Bars rows={data.oses} />
            <h3 style={{ marginTop: 14 }}>Language</h3>
            <Bars rows={data.languages} />
          </Section>
        </>
      )}

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Visits</h2>
          <a href={`/api/links/${id}/views.csv?${qs}`}>
            <button className="small">Export CSV</button>
          </a>
        </div>
        {sessions.length === 0 && <div className="empty">No visits in this range.</div>}
        {sessions.map((v) => (
          <SessionCard key={v.id} s={v} linkId={id} urlKind={link?.kind === 'url'} />
        ))}
        {more && sessions.length > 0 && (
          <button onClick={loadMore} disabled={loading} style={{ width: '100%', marginTop: 10 }}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </>
  );
}

/* ---------- overview across links ---------- */
interface Overview {
  days: number;
  totals: { viewsAll: number; views: number; visitors: number; avgActiveMs: number; avgDepth: number; links: number };
  timeline: { day: string; views: number; visitors: number }[];
  topLinks: { id: string; title: string; slug: string; recipient: string | null; kind: string; views: number; visitors: number; avgActiveMs: number; lastViewed: string }[];
  countries: Row[];
  sources: Row[];
  devices: Row[];
  recent: Session[];
  byUser: { email: string; displayName: string; links: number; views: number }[];
}

export function StatsOverview({ admin }: { admin: boolean }) {
  const [range, setRange] = useState('30d');
  const [d, setD] = useState<Overview | null>(null);
  useEffect(() => {
    setD(null);
    void api<Overview>('GET', `/stats/overview?range=${range}&tz=${encodeURIComponent(tz())}`).then(setD);
  }, [range]);
  return (
    <>
      <h1>Stats</h1>
      <div style={{ margin: '10px 0 14px' }}>
        <RangePicker value={range} onChange={(r) => setRange(r === 'all' ? '90d' : r)} />
      </div>
      {!d && <p className="muted">Loading…</p>}
      {d && (
        <>
          <div className="stats-grid">
            <Stat label={`Views (${d.days}d)`} value={fmtNum(d.totals.views)} sub={`${fmtNum(d.totals.viewsAll)} all time`} />
            <Stat label="Unique visitors" value={fmtNum(d.totals.visitors)} />
            <Stat label="Avg. active time" value={fmtDuration(d.totals.avgActiveMs)} />
            <Stat label="Avg. depth" value={pct(d.totals.avgDepth)} sub={`${d.totals.links} links`} />
          </div>
          <Section title="Views over time">
            <TimelineChart data={d.timeline} />
          </Section>
          <Section title="Top links">
            {d.topLinks.length === 0 && <p className="muted">No views in this range.</p>}
            {d.topLinks.map((l) => (
              <div className="audit-row" key={l.id}>
                <div className="row between">
                  <span>
                    <Link to={`/links/${l.id}/stats`}>
                      <b>{l.title}</b>
                    </Link>
                    {l.recipient && <span className="muted"> · {l.recipient}</span>}
                  </span>
                  <span className="num">
                    <b>{fmtNum(l.views)}</b> <span className="muted">{l.views === 1 ? 'view' : 'views'}</span>
                  </span>
                </div>
                <div className="muted num" style={{ fontSize: '0.8rem' }}>
                  {l.visitors} {l.visitors === 1 ? 'visitor' : 'visitors'}
                  {l.kind === 'file' ? ` · avg. active ${fmtDuration(l.avgActiveMs)}` : ''} · last {when(l.lastViewed)}
                </div>
              </div>
            ))}
          </Section>
          <Section title="Recent visits">
            {d.recent.length === 0 && <p className="muted">Nothing yet.</p>}
            {d.recent.map((v) => (
              <SessionCard key={v.id} s={v} showLink />
            ))}
          </Section>
          <Section title="Sources">
            <Bars rows={d.sources} />
          </Section>
          <Section title="Countries">
            <Bars rows={d.countries} label={(r) => countryName(r.name)} />
          </Section>
          <Section title="Devices">
            <Bars rows={d.devices} />
          </Section>
          {admin && d.byUser.length > 0 && (
            <Section title="By user">
              {d.byUser.map((u) => (
                <div className="audit-row row between" key={u.email}>
                  <span>
                    <b>{u.displayName}</b> <span className="muted">{u.email}</span>
                  </span>
                  <span className="num muted">
                    {u.links} links · <b style={{ color: 'var(--text)' }}>{fmtNum(u.views)}</b> views
                  </span>
                </div>
              ))}
            </Section>
          )}
        </>
      )}
    </>
  );
}

/* ---------- one visitor ---------- */
interface VisitorDetailData {
  summary: { visits: number; firstSeen: string; lastSeen: string; totalActiveMs: number; avgActiveMs: number; deepestPage: number; pageCount: number; avgDepth: number };
  pages: { pageNo: number; totalDwellMs: number; visitsWithPage: number }[];
  visits: Session[];
}

export function VisitorDetail() {
  const { id, key } = useParams();
  const [d, setD] = useState<VisitorDetailData | null>(null);
  const [missing, setMissing] = useState(false);
  const [title, setTitle] = useState('');
  useEffect(() => {
    void api<{ link: { title: string } }>('GET', `/links/${id}`).then((r) => setTitle(r.link.title));
    api<VisitorDetailData>('GET', `/links/${id}/visitors/${key}?range=all&bots=1&owner=1`)
      .then(setD)
      .catch(() => setMissing(true));
  }, [id, key]);

  if (missing) return <div className="card empty">Visitor not found.</div>;
  if (!d) return <p className="muted">Loading…</p>;
  const maxDwell = Math.max(1, ...d.pages.map((p) => p.totalDwellMs));
  const top = [...d.pages].sort((a, b) => b.totalDwellMs - a.totalDwellMs)[0];
  const s = d.summary;
  return (
    <>
      <div className="row between">
        <h1>Visitor {String(key).slice(0, 6)}</h1>
        <Link to={`/links/${id}/stats`}>
          <button className="small">Back to stats</button>
        </Link>
      </div>
      <p className="muted">{title}</p>
      <div className="stats-grid">
        <Stat label="Visits" value={s.visits} sub={`first ${when(s.firstSeen)}`} />
        <Stat label="Total active time" value={fmtDuration(s.totalActiveMs)} sub={`${fmtDuration(s.avgActiveMs)} per visit`} />
        <Stat label="Deepest page" value={s.deepestPage ? `${s.deepestPage}${s.pageCount ? ` / ${s.pageCount}` : ''}` : '—'} sub={s.avgDepth ? `${pct(s.avgDepth)} avg. depth` : undefined} />
        <Stat label="Last seen" value={<span style={{ fontSize: '1rem' }}>{when(s.lastSeen)}</span>} />
      </div>
      {d.pages.length > 0 && (
        <Section title="Time per page">
          {top && (
            <p>
              Most time on <b>page {top.pageNo}</b> ({fmtDuration(top.totalDwellMs)} in total).
            </p>
          )}
          <div className="pages">
            {d.pages.map((p) => (
              <div className="pg-row" key={p.pageNo}>
                <div className="pg-no num">{p.pageNo}</div>
                <div className="bar-track">
                  <div className="bar-fill dwell" style={{ width: `${(p.totalDwellMs / maxDwell) * 100}%` }} />
                </div>
                <div className="pg-val num">{fmtDuration(p.totalDwellMs)}</div>
              </div>
            ))}
          </div>
        </Section>
      )}
      <div className="card">
        <h2>Visits</h2>
        {d.visits.map((v) => (
          <SessionCard key={v.id} s={v} />
        ))}
      </div>
    </>
  );
}
