import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, errorMessage } from './api';
import { Signature, SignatureToggle, isEmptySig, useMySignature } from './Signature';

export interface LinkItem {
  id: string;
  slug: string;
  kind: 'file' | 'url';
  title: string;
  recipient: string | null;
  tags: string[];
  stamp: boolean;
  allowDownload: boolean;
  signature: Signature | null;
  status: 'active' | 'disabled';
  effectiveStatus: 'active' | 'disabled' | 'expired';
  destinationUrl: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  maxViews: number | null;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  ownerEmail: string;
  views: number;
  versionNo: number | null;
  pageCount: number | null;
  sizeBytes: string | null;
  originalName: string | null;
  hasMobile: boolean;
  mobilePageCount: number | null;
  mobileName: string | null;
}

interface Version {
  id: string;
  versionNo: number;
  originalName: string | null;
  pageCount: number;
  sizeBytes: string;
  note: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  current: boolean;
  files: { variant: 'desktop' | 'mobile'; originalName: string | null; pageCount: number; sizeBytes: string }[];
}

const msg = (e: unknown) => errorMessage(e);

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtSize = (b: string | number | null) => {
  const n = Number(b ?? 0);
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
};
// <input type="datetime-local"> value <-> ISO
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const parseTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function StatusBadge({ l }: { l: LinkItem }) {
  if (l.effectiveStatus === 'disabled') return <span className="badge off">Off</span>;
  if (l.effectiveStatus === 'expired') return <span className="badge off">Expired</span>;
  return <span className="badge ok">Active</span>;
}

function Tags({ tags, onPick, active }: { tags: string[]; onPick?: (t: string) => void; active?: string }) {
  if (!tags.length) return null;
  return (
    <span className="tags">
      {tags.map((t) =>
        onPick ? (
          <button type="button" key={t} className={`tag ${active === t ? 'on' : ''}`} onClick={() => onPick(t)}>
            #{t}
          </button>
        ) : (
          <span key={t} className="tag">
            #{t}
          </span>
        ),
      )}
    </span>
  );
}

/* ---------------- list ---------------- */
export function LinksList({ admin }: { admin: boolean }) {
  const [links, setLinks] = useState<LinkItem[] | null>(null);
  const [copied, setCopied] = useState('');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  useEffect(() => {
    void api<{ links: LinkItem[] }>('GET', '/links').then((r) => setLinks(r.links));
  }, []);

  const allTags = useMemo(() => [...new Set((links ?? []).flatMap((l) => l.tags))].sort(), [links]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (links ?? []).filter(
      (l) =>
        (!tag || l.tags.includes(tag)) &&
        (!needle || [l.title, l.slug, l.recipient ?? '', l.ownerEmail, ...l.tags].some((s) => s.toLowerCase().includes(needle))),
    );
  }, [links, q, tag]);

  return (
    <>
      <h1>Links</h1>
      {links === null && <p className="muted">Loading…</p>}
      {links && links.length > 0 && (
        <div className="stack" style={{ marginBottom: 14 }}>
          <input type="search" placeholder="Search by title, recipient, slug or tag" value={q} onChange={(e) => setQ(e.target.value)} />
          {allTags.length > 0 && <Tags tags={allTags} active={tag} onPick={(t) => setTag(tag === t ? '' : t)} />}
        </div>
      )}
      {links && links.length === 0 && (
        <div className="card empty">
          <p>No links yet.</p>
          <Link to="/new">Upload your first document</Link>
        </div>
      )}
      {links && links.length > 0 && shown.length === 0 && <div className="card empty">No links match your search.</div>}
      {shown.map((l) => {
        const url = `${location.origin}/${l.slug}`;
        return (
          <div className="card user" key={l.id}>
            <div className="row between">
              <Link to={`/links/${l.id}`} style={{ color: 'var(--text)', fontWeight: 600, textDecoration: 'none' }}>
                {l.title}
              </Link>
              <StatusBadge l={l} />
            </div>
            {l.recipient && (
              <div>
                <span className="muted">For: </span>
                <b>{l.recipient}</b>
              </div>
            )}
            <div className="row muted num" style={{ fontSize: '0.8rem' }}>
              <span>{l.kind === 'file' ? `PDF · ${plural(l.pageCount ?? 0, 'page')}${l.hasMobile ? ` + mobile ${plural(l.mobilePageCount ?? 0, 'page')}` : ''}` : 'Short URL'}</span>
              <span>· {plural(l.views, 'view')}</span>
              {l.hasPassword && <span>· 🔒 password</span>}
              {l.allowDownload && <span>· download on</span>}
              {l.expiresAt && <span>· expires {fmtDate(l.expiresAt)}</span>}
              {admin && <span>· {l.ownerEmail}</span>}
            </div>
            <div className="row link-actions" style={{ marginTop: 6 }}>
              <button
                className="small"
                onClick={async () => {
                  if (await copy(url)) {
                    setCopied(l.id);
                    setTimeout(() => setCopied(''), 1500);
                  }
                }}
              >
                {copied === l.id ? 'Copied ✓' : 'Copy link'}
              </button>
              <a href={`/${l.slug}`} target="_blank" rel="noreferrer">
                <button className="small">Open</button>
              </a>
              <Link to={`/links/${l.id}/stats`}>
                <button className="small">Stats</button>
              </Link>
              <Link to={`/links/${l.id}`}>
                <button className="small">Manage</button>
              </Link>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ---------------- upload with progress ---------------- */
function upload(path: string, form: FormData, onProgress: (p: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api${path}`);
    x.withCredentials = true;
    const m = document.cookie.match(/(?:^|; )docs_csrf=([^;]+)/);
    x.setRequestHeader('x-csrf-token', m ? decodeURIComponent(m[1]) : '');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(x.responseText);
      } catch {
        /* empty */
      }
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(new ApiError(x.status, data?.error ?? 'error', data?.details));
    };
    x.onerror = () => reject(new ApiError(0, 'network'));
    x.send(form);
  });
}

/** Recipient + tags fields, shared by the "new" and "settings" forms. */
function WhoFields({
  recipient,
  tags,
  onRecipient,
  onTags,
  suggestions,
  stamp,
  onStamp,
  allowDownload,
  onAllowDownload,
}: {
  recipient: string;
  tags: string;
  onRecipient: (v: string) => void;
  onTags: (v: string) => void;
  suggestions: string[];
  /** Present only for file links (the stamp is burned into the PDF pages). */
  stamp?: boolean;
  onStamp?: (v: boolean) => void;
  /** Present only for file links: let viewers download the PDF. */
  allowDownload?: boolean;
  onAllowDownload?: (v: boolean) => void;
}) {
  return (
    <>
      <div>
        <label>Who is this link for? (recipient)</label>
        <input value={recipient} maxLength={200} placeholder="e.g. Jane Doe — Acme Ventures" onChange={(e) => onRecipient(e.target.value)} />
        {stamp !== undefined && onStamp && (
          <label className="check" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={stamp} onChange={(e) => onStamp(e.target.checked)} />
            <span>
              Stamp <b>Confidential — for {recipient.trim() || '…'}</b> in the top-right corner of every page
            </span>
          </label>
        )}
      </div>
      {allowDownload !== undefined && onAllowDownload && (
        <div>
          <label className="check">
            <input type="checkbox" checked={allowDownload} onChange={(e) => onAllowDownload(e.target.checked)} />
            <span>
              <b>Allow download</b>: show a "Download PDF" button in the viewer
            </span>
          </label>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '4px 0 0' }}>
            Off by default: the document is view-only. When on, anyone who can open the link can save a copy. With a recipient stamp, the downloaded copy carries the stamp (as page images, no selectable text).
          </p>
        </div>
      )}
      <div>
        <label>Tags (comma-separated, optional)</label>
        <input value={tags} list="known-tags" placeholder="e.g. investor, seed-round" onChange={(e) => onTags(e.target.value)} autoCapitalize="none" />
        <datalist id="known-tags">
          {suggestions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
    </>
  );
}

function useKnownTags(): string[] {
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    void api<{ links: LinkItem[] }>('GET', '/links')
      .then((r) => setTags([...new Set(r.links.flatMap((l) => l.tags))].sort()))
      .catch(() => {});
  }, []);
  return tags;
}

/** One PDF picker (desktop or mobile file). */
function PdfSlot({ label, file, onFile, disabled, current }: { label: string; file: File | null; onFile: (f: File | null) => void; disabled?: boolean; current?: string | null }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <label>{label}</label>
      <input
        ref={ref}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          onFile(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <button type="button" className={file ? '' : 'primary'} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => ref.current?.click()} disabled={disabled}>
          {file ? `${file.name} (${fmtSize(file.size)})` : 'Choose PDF'}
        </button>
        {file && (
          <button type="button" className="small" onClick={() => onFile(null)} disabled={disabled}>
            Clear
          </button>
        )}
      </div>
      {current !== undefined && <div className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>Current: {current || 'none'}</div>}
    </div>
  );
}

/* ---------------- new ---------------- */
export function NewLink() {
  const nav = useNavigate();
  const known = useKnownTags();
  const [kind, setKind] = useState<'file' | 'url'>('file');
  const mySig = useMySignature();
  const [f, setF] = useState({ title: '', recipient: '', tags: '', stamp: true, allowDownload: false, sig: null as Signature | null, slug: '', password: '', expiresAt: '', maxViews: '', destinationUrl: '' });
  const [file, setFile] = useState<File | null>(null);
  const [mobileFile, setMobileFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      let res: { id: string };
      if (kind === 'file') {
        const first = file ?? mobileFile;
        if (!first) return setErr(msg(new ApiError(400, 'file_required')));
        const fd = new FormData();
        fd.append('kind', 'file');
        fd.append('title', f.title || first.name.replace(/\.pdf$/i, ''));
        if (f.recipient) fd.append('recipient', f.recipient);
        fd.append('stamp', f.stamp ? '1' : '0');
        fd.append('allowDownload', f.allowDownload ? '1' : '0');
        if (f.sig && !isEmptySig(f.sig)) fd.append('signature', JSON.stringify(f.sig));
        if (f.tags) fd.append('tags', parseTags(f.tags).join(','));
        if (f.slug) fd.append('slug', f.slug);
        if (f.password) fd.append('password', f.password);
        const iso = fromLocalInput(f.expiresAt);
        if (iso) fd.append('expiresAt', iso);
        if (f.maxViews) fd.append('maxViews', f.maxViews);
        // files last so the text fields are parsed first
        if (file) fd.append('desktop', file);
        if (mobileFile) fd.append('mobile', mobileFile);
        setProgress(0);
        res = await upload('/links', fd, (p) => {
          setProgress(p);
          if (p >= 1) setProcessing(true);
        });
      } else {
        res = await api('POST', '/links', {
          kind: 'url',
          title: f.title || f.destinationUrl,
          recipient: f.recipient || null,
          tags: parseTags(f.tags),
          slug: f.slug || undefined,
          expiresAt: fromLocalInput(f.expiresAt),
          maxViews: f.maxViews ? Number(f.maxViews) : null,
          destinationUrl: f.destinationUrl,
        });
      }
      nav(`/links/${res.id}`);
    } catch (x) {
      setErr(msg(x));
      setProgress(null);
      setProcessing(false);
    }
  }

  const busy = progress !== null;
  return (
    <>
      <h1>New link</h1>
      <div className="seg" style={{ marginBottom: 14 }}>
        <button type="button" className={kind === 'file' ? 'on' : ''} onClick={() => setKind('file')}>
          File (PDF)
        </button>
        <button type="button" className={kind === 'url' ? 'on' : ''} onClick={() => setKind('url')}>
          Short URL
        </button>
      </div>
      <form className="card stack" onSubmit={submit}>
        {kind === 'file' ? (
          <div className="stack">
            <PdfSlot label="Desktop PDF" file={file} onFile={setFile} disabled={busy} />
            <PdfSlot label="Mobile PDF (optional)" file={mobileFile} onFile={setMobileFile} disabled={busy} />
            <p className="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
              Upload <b>one PDF</b> to show it on every device, or <b>two</b> to show the mobile PDF on phones and the desktop PDF everywhere else. 100 MB maximum per file.
            </p>
          </div>
        ) : (
          <div>
            <label>Destination URL</label>
            <input type="url" placeholder="https://…" value={f.destinationUrl} onChange={(e) => setF({ ...f, destinationUrl: e.target.value })} required />
          </div>
        )}
        <div>
          <label>Title</label>
          <input value={f.title} placeholder={kind === 'file' ? 'Defaults to the file name' : ''} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </div>
        <WhoFields
          recipient={f.recipient}
          tags={f.tags}
          suggestions={known}
          onRecipient={(v) => setF({ ...f, recipient: v })}
          onTags={(v) => setF({ ...f, tags: v })}
          stamp={kind === 'file' ? f.stamp : undefined}
          onStamp={(v) => setF({ ...f, stamp: v })}
          allowDownload={kind === 'file' ? f.allowDownload : undefined}
          onAllowDownload={(v) => setF({ ...f, allowDownload: v })}
        />
        {kind === 'file' && <SignatureToggle sig={f.sig} saved={mySig} onChange={(v) => setF({ ...f, sig: v })} />}
        <div>
          <label>Slug (link name, optional)</label>
          <input value={f.slug} placeholder="e.g. pitchdeck — generated if left empty" onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} autoCapitalize="none" />
          <div className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>
            {location.origin}/{f.slug || '…'}
          </div>
        </div>
        {kind === 'file' && (
          <div>
            <label>Password (optional)</label>
            <input type="text" autoComplete="off" value={f.password} placeholder="Leave empty for no password" onChange={(e) => setF({ ...f, password: e.target.value })} />
          </div>
        )}
        <div>
          <label>Expiry date (optional)</label>
          <input type="datetime-local" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} />
        </div>
        <div>
          <label>View limit (optional)</label>
          <input type="number" min={1} inputMode="numeric" value={f.maxViews} onChange={(e) => setF({ ...f, maxViews: e.target.value })} />
        </div>
        {busy && (
          <div>
            <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round((progress ?? 0) * 100)}%`, background: 'var(--accent)', transition: 'width .2s' }} />
            </div>
            <p className="muted" style={{ marginTop: 6 }}>
              {processing ? 'Converting the PDF to pages… (this can take a few seconds)' : `Uploading… ${Math.round((progress ?? 0) * 100)}%`}
            </p>
          </div>
        )}
        {err && <div className="alert bad">{err}</div>}
        <button className="primary" disabled={busy}>
          {kind === 'file' ? 'Upload and create link' : 'Create short link'}
        </button>
      </form>
    </>
  );
}

/* ---------------- detail ---------------- */
export function LinkDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const known = useKnownTags();
  const [data, setData] = useState<{ link: LinkItem; versions: Version[]; url: string } | null>(null);
  const mySig = useMySignature();
  const [edit, setEdit] = useState({ title: '', recipient: '', tags: '', stamp: true, allowDownload: false, sig: null as Signature | null, slug: '', expiresAt: '', maxViews: '', destinationUrl: '', password: '' });
  const [saving, setSaving] = useState(false);
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [srcTag, setSrcTag] = useState('');
  const [copiedTag, setCopiedTag] = useState(false);
  const [note, setNote] = useState('');
  const [newDesktop, setNewDesktop] = useState<File | null>(null);
  const [newMobile, setNewMobile] = useState<File | null>(null);
  const [removeMobile, setRemoveMobile] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ link: LinkItem; versions: Version[]; url: string }>('GET', `/links/${id}`);
    setData(r);
    setEdit({
      title: r.link.title,
      recipient: r.link.recipient ?? '',
      tags: r.link.tags.join(', '),
      stamp: r.link.stamp,
      allowDownload: r.link.allowDownload,
      sig: r.link.signature,
      slug: r.link.slug,
      expiresAt: toLocalInput(r.link.expiresAt),
      maxViews: r.link.maxViews ? String(r.link.maxViews) : '',
      destinationUrl: r.link.destinationUrl ?? '',
      password: '',
    });
  }, [id]);
  useEffect(() => {
    load().catch(() => nav('/'));
  }, [load, nav]);

  if (!data) return <p className="muted">Loading…</p>;
  const { link, versions, url } = data;
  const tagClean = srcTag.trim().toLowerCase().replace(/\s+/g, '-');
  const taggedUrl = `${url}?src=${encodeURIComponent(tagClean || 'name')}`;
  const act = async (fn: () => Promise<unknown>, ok = 'Saved.') => {
    setM(null);
    try {
      await fn();
      await load();
      setM({ ok: true, text: ok });
    } catch (x) {
      setM({ ok: false, text: msg(x) });
    }
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    await act(() =>
      api('PATCH', `/links/${link.id}`, {
        title: edit.title,
        recipient: edit.recipient || null,
        tags: parseTags(edit.tags),
        ...(link.kind === 'file' ? { stamp: edit.stamp, allowDownload: edit.allowDownload, signature: isEmptySig(edit.sig) ? null : edit.sig } : {}),
        slug: edit.slug,
        expiresAt: fromLocalInput(edit.expiresAt),
        maxViews: edit.maxViews ? Number(edit.maxViews) : null,
        ...(link.kind === 'url' ? { destinationUrl: edit.destinationUrl } : {}),
      }),
    );
    setSaving(false);
  }

  async function newVersion() {
    const fd = new FormData();
    if (note) fd.append('note', note);
    if (removeMobile && !newMobile) fd.append('removeMobile', '1');
    if (newDesktop) fd.append('desktop', newDesktop);
    if (newMobile) fd.append('mobile', newMobile);
    setM(null);
    setProgress(0);
    try {
      await upload(`/links/${link.id}/versions`, fd, (p) => setProgress(p));
      setNote('');
      setNewDesktop(null);
      setNewMobile(null);
      setRemoveMobile(false);
      await load();
      setM({ ok: true, text: 'New version uploaded. The link and its stats stayed the same.' });
    } catch (x) {
      setM({ ok: false, text: msg(x) });
    }
    setProgress(null);
  }

  return (
    <>
      <div className="row between">
        <h1 style={{ wordBreak: 'break-word' }}>{link.title}</h1>
        <StatusBadge l={link} />
      </div>
      {link.recipient && (
        <p>
          <span className="muted">For: </span>
          <b>{link.recipient}</b> <Tags tags={link.tags} />
        </p>
      )}
      {!link.recipient && <Tags tags={link.tags} />}
      {m && <div className={`alert ${m.ok ? 'ok' : 'bad'}`}>{m.text}</div>}

      <div className="card stack" style={{ marginTop: 12 }}>
        <div className="secret" style={{ fontSize: '0.95rem' }}>
          {url}
        </div>
        <div className="row">
          <button
            className="primary"
            onClick={async () => {
              if (await copy(url)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            {copied ? 'Copied ✓' : 'Copy link'}
          </button>
          <a href={url} target="_blank" rel="noreferrer">
            <button>Open</button>
          </a>
          {link.hasMobile && (
            <>
              <a href={`${url}?view=desktop`} target="_blank" rel="noreferrer">
                <button className="small">Preview desktop</button>
              </a>
              <a href={`${url}?view=mobile`} target="_blank" rel="noreferrer">
                <button className="small">Preview mobile</button>
              </a>
            </>
          )}
          <Link to={`/links/${link.id}/stats`}>
            <button>Stats</button>
          </Link>
          <button
            onClick={() =>
              act(() => api('PATCH', `/links/${link.id}`, { status: link.status === 'active' ? 'disabled' : 'active' }), link.status === 'active' ? 'Link turned off.' : 'Link turned on.')
            }
          >
            {link.status === 'active' ? 'Turn off' : 'Turn on'}
          </button>
        </div>
        <div className="row muted num" style={{ fontSize: '0.85rem' }}>
          <span>{plural(link.views, 'view')}</span>
          {link.kind === 'file' && (
            <span>
              · v{link.versionNo} · {plural(link.pageCount ?? 0, 'page')} · {fmtSize(link.sizeBytes)}
              {link.hasMobile ? ` · mobile PDF: ${plural(link.mobilePageCount ?? 0, 'page')}` : ' · same file on every device'}
            </span>
          )}
          <span>· created {fmtDate(link.createdAt)}</span>
          {link.hasPassword && <span>· 🔒 password</span>}
        </div>
        <div style={{ textAlign: 'center' }}>
          <img src={`/api/links/${link.id}/qr.svg`} alt="QR code" width={160} height={160} style={{ background: '#fff', borderRadius: 8 }} />
          <div>
            <a href={`/api/links/${link.id}/qr.svg`} download={`${link.slug}-qr.svg`}>
              Download QR code (SVG)
            </a>
          </div>
        </div>
      </div>

      <div className="card stack">
        <h2>Tracked link</h2>
        <p className="muted" style={{ margin: 0 }}>
          Add a tag to tell shares apart: one tag per person or channel (e.g. a name or <code>linkedin-post</code>). Everyone still sees the same document, and Stats shows each tag separately.
        </p>
        <input value={srcTag} placeholder="Tag, e.g. umut" maxLength={64} autoCapitalize="none" onChange={(e) => setSrcTag(e.target.value)} />
        <div className="secret" style={{ fontSize: '0.9rem' }}>
          {taggedUrl}
        </div>
        <button
          disabled={!srcTag.trim()}
          onClick={async () => {
            if (await copy(taggedUrl)) {
              setCopiedTag(true);
              setTimeout(() => setCopiedTag(false), 1500);
            }
          }}
        >
          {copiedTag ? 'Copied ✓' : 'Copy tracked link'}
        </button>
      </div>

      <form className="card stack" onSubmit={save}>
        <h2>Settings</h2>
        <div>
          <label>Title</label>
          <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} required />
        </div>
        <WhoFields
          recipient={edit.recipient}
          tags={edit.tags}
          suggestions={known}
          onRecipient={(v) => setEdit({ ...edit, recipient: v })}
          onTags={(v) => setEdit({ ...edit, tags: v })}
          stamp={link.kind === 'file' ? edit.stamp : undefined}
          onStamp={(v) => setEdit({ ...edit, stamp: v })}
          allowDownload={link.kind === 'file' ? edit.allowDownload : undefined}
          onAllowDownload={(v) => setEdit({ ...edit, allowDownload: v })}
        />
        {link.kind === 'file' && <SignatureToggle sig={edit.sig} saved={mySig} onChange={(v) => setEdit({ ...edit, sig: v })} />}
        {link.kind === 'file' && (
          <p className="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
            The stamp is burned into every page image. Changing the recipient or this option re-renders all versions (a few seconds).
          </p>
        )}
        <div>
          <label>Slug</label>
          <input value={edit.slug} onChange={(e) => setEdit({ ...edit, slug: e.target.value.toLowerCase() })} autoCapitalize="none" />
          <div className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>
            If you change the slug, the old link stops working.
          </div>
        </div>
        {link.kind === 'url' && (
          <div>
            <label>Destination URL</label>
            <input type="url" value={edit.destinationUrl} onChange={(e) => setEdit({ ...edit, destinationUrl: e.target.value })} required />
          </div>
        )}
        <div>
          <label>Expiry date</label>
          <input type="datetime-local" value={edit.expiresAt} onChange={(e) => setEdit({ ...edit, expiresAt: e.target.value })} />
        </div>
        <div>
          <label>View limit</label>
          <input type="number" min={1} inputMode="numeric" value={edit.maxViews} onChange={(e) => setEdit({ ...edit, maxViews: e.target.value })} />
        </div>
        <button className="primary" disabled={saving}>
          {saving ? (link.kind === 'file' ? 'Saving and re-rendering pages…' : 'Saving…') : 'Save'}
        </button>
      </form>

      {link.kind === 'file' && (
        <>
          <div className="card stack">
            <h2>Password</h2>
            <p className="muted">{link.hasPassword ? 'This link is password protected.' : 'This link has no password.'}</p>
            <div>
              <label>{link.hasPassword ? 'New password' : 'Set a password'}</label>
              <input type="text" autoComplete="off" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
            </div>
            <div className="row">
              <button
                disabled={edit.password.length < 4}
                onClick={() =>
                  act(async () => {
                    await api('PATCH', `/links/${link.id}`, { password: edit.password });
                  }, 'Password saved.')
                }
              >
                Save password
              </button>
              {link.hasPassword && (
                <button className="danger" onClick={() => act(() => api('PATCH', `/links/${link.id}`, { password: null }), 'Password removed.')}>
                  Remove password
                </button>
              )}
            </div>
          </div>

          <div className="card stack">
            <h2>Replace files</h2>
            <p className="muted">
              Upload a new version. The link, slug and past stats stay the same and older versions are kept. Choose only the file(s) you want to change; the other one is carried over.
            </p>
            <PdfSlot label="New desktop PDF" file={newDesktop} onFile={setNewDesktop} disabled={progress !== null} current={link.originalName} />
            <PdfSlot label="New mobile PDF" file={newMobile} onFile={setNewMobile} disabled={progress !== null} current={link.hasMobile ? link.mobileName : null} />
            {link.hasMobile && (
              <label className="check">
                <input type="checkbox" checked={removeMobile} disabled={!!newMobile} onChange={(e) => setRemoveMobile(e.target.checked)} />
                <span>Remove the mobile PDF (use the desktop PDF on phones too)</span>
              </label>
            )}
            <div>
              <label>Version note (optional)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button className="primary" onClick={() => void newVersion()} disabled={progress !== null || (!newDesktop && !newMobile && !(removeMobile && link.hasMobile))}>
              {progress === null ? 'Upload new version' : progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Processing…'}
            </button>
            {versions.map((v) => (
              <div className="audit-row" key={v.id}>
                <div className="row between">
                  <b>
                    v{v.versionNo} {v.current && <span className="badge ok">Live</span>}
                  </b>
                  {!v.current && (
                    <button className="small" onClick={() => act(() => api('POST', `/links/${link.id}/versions/${v.id}/activate`), `v${v.versionNo} is now live.`)}>
                      Make live
                    </button>
                  )}
                </div>
                <div className="muted num" style={{ fontSize: '0.8rem' }}>
                  {(v.files?.length ? v.files : [{ variant: 'desktop' as const, originalName: v.originalName, pageCount: v.pageCount, sizeBytes: v.sizeBytes }])
                    .map((f) => `${v.files?.length > 1 ? (f.variant === 'mobile' ? 'Mobile' : 'Desktop') + ': ' : ''}${f.originalName} (${plural(f.pageCount, 'page')}, ${fmtSize(f.sizeBytes)})`)
                    .join(' · ')}{' '}
                  · {fmtDate(v.uploadedAt)}
                  {v.note ? ` · ${v.note}` : ''}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="card">
        <button
          className="danger"
          onClick={async () => {
            if (!confirm(`Permanently delete "${link.title}" with all of its versions and stats?`)) return;
            await api('DELETE', `/links/${link.id}`);
            nav('/');
          }}
        >
          Delete link
        </button>
      </div>
    </>
  );
}
