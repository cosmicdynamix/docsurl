import { useEffect, useState } from 'react';
import { api } from './api';

export interface Signature {
  name?: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  website?: string;
  note?: string;
}

const FIELDS: { key: keyof Signature; label: string; placeholder: string; max: number }[] = [
  { key: 'name', label: 'Name', placeholder: 'Jane Doe', max: 100 },
  { key: 'title', label: 'Title', placeholder: 'Founder & CEO', max: 100 },
  { key: 'company', label: 'Company', placeholder: 'Acme Inc.', max: 100 },
  { key: 'email', label: 'Email', placeholder: 'jane@acme.com', max: 150 },
  { key: 'phone', label: 'Phone', placeholder: '+1 555 010 0000', max: 40 },
  { key: 'website', label: 'Website / link', placeholder: 'acme.com', max: 200 },
  { key: 'note', label: 'Short note', placeholder: 'Confidential. Please do not forward. Links like https://acme.com or <a href="https://acme.com">Our site</a> work.', max: 500 },
];

type NotePart = { text: string; href?: string };
const NOTE_RE = /<a\s+href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>|\[([^\]]{1,100})\]\(([^)\s]+)\)|https?:\/\/[^\s<>"']+|[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/gi;
const safeHref = (h: string): string | null => (/^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(h.trim()) ? h.trim() : null);

/** Mirror of the server's note parser (src/signature.ts): only simple links become clickable, everything else is plain text. */
function parseNote(note: string): NotePart[] {
  const out: NotePart[] = [];
  let last = 0;
  for (const m of note.matchAll(NOTE_RE)) {
    if (m.index! > last) out.push({ text: note.slice(last, m.index) });
    last = m.index! + m[0].length;
    if (m[1] !== undefined || m[4] !== undefined) {
      const href = safeHref(m[1] ?? m[4]);
      const label = (m[2] ?? m[3]).replace(/<[^>]*>/g, '').trim();
      out.push(href ? { text: label || href, href } : { text: m[0] });
    } else if (m[0].includes('://')) out.push({ text: m[0], href: m[0] });
    else out.push({ text: m[0], href: `mailto:${m[0]}` });
  }
  if (last < note.length) out.push({ text: note.slice(last) });
  return out;
}

export const isEmptySig = (s: Signature | null | undefined): boolean => !s || !Object.values(s).some((v) => v && String(v).trim());

/** The saved default signature of the signed-in user (null until loaded or when none is set). */
export function useMySignature(): Signature | null | undefined {
  const [sig, setSig] = useState<Signature | null | undefined>(undefined);
  useEffect(() => {
    void api<{ user: { signature: Signature | null } }>('GET', '/me')
      .then((r) => setSig(r.user.signature ?? null))
      .catch(() => setSig(null));
  }, []);
  return sig;
}

export function SignatureFields({ value, onChange }: { value: Signature; onChange: (v: Signature) => void }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      {FIELDS.map((f) => (
        <div key={f.key}>
          <label>{f.label}</label>
          {f.key === 'note' ? (
            <textarea rows={3} maxLength={f.max} value={value[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
          ) : (
            <input maxLength={f.max} value={value[f.key] ?? ''} placeholder={f.placeholder} autoCapitalize="none" onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
          )}
        </div>
      ))}
    </div>
  );
}

/** Small preview that mirrors the footer recipients see. */
export function SignaturePreview({ value }: { value: Signature }) {
  if (isEmptySig(value)) return null;
  const who = [value.name, value.title].filter(Boolean);
  const contact = [value.email, value.phone, value.website].filter(Boolean);
  return (
    <div className="sig-preview">
      {who.length > 0 && (
        <div>
          <b>{who[0]}</b>
          {who[1] ? ` · ${who[1]}` : ''}
        </div>
      )}
      {value.company && <div>{value.company}</div>}
      {contact.length > 0 && <div className="accent">{contact.join(' · ')}</div>}
      {value.note && (
        <div style={{ fontSize: '0.8rem', marginTop: 4, whiteSpace: 'pre-line' }}>
          {parseNote(value.note).map((p, i) =>
            p.href ? (
              <a key={i} className="accent" href={p.href} target="_blank" rel="noopener noreferrer nofollow">
                {p.text}
              </a>
            ) : (
              <span key={i}>{p.text}</span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Add my signature" toggle with editable fields, for the new-link and manage forms.
 * `sig === null` means the signature is off. Turning it on pre-fills the saved default.
 */
export function SignatureToggle({ sig, onChange, saved }: { sig: Signature | null; onChange: (v: Signature | null) => void; saved: Signature | null | undefined }) {
  const on = sig !== null;
  return (
    <div>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? { ...(saved ?? {}) } : null)} />
        <span>
          <b>Add a signature footer</b>: show your details at the bottom of the document page
        </span>
      </label>
      {on && (
        <div className="stack" style={{ marginTop: 10 }}>
          {isEmptySig(saved) && (
            <p className="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
              Tip: save a default signature under Account and it will be filled in here automatically.
            </p>
          )}
          <SignatureFields value={sig!} onChange={onChange} />
          <SignaturePreview value={sig!} />
        </div>
      )}
    </div>
  );
}
