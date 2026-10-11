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
  { key: 'note', label: 'Short note', placeholder: 'Confidential. Please do not forward.', max: 300 },
];

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
            <textarea rows={2} maxLength={f.max} value={value[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
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
      {value.note && <div style={{ fontSize: '0.8rem', marginTop: 4 }}>{value.note}</div>}
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
