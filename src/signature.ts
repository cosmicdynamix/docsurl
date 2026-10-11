import { z } from 'zod';

/** Short sender details shown as a footer under a shared document. Every field is optional. */
export interface Signature {
  name?: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  website?: string;
  note?: string;
}

const short = (max: number) => z.string().trim().max(max).optional();

const shape = z.object({
  name: short(100),
  title: short(100),
  company: short(100),
  email: short(150),
  phone: short(40),
  website: short(200),
  note: short(300),
});

const KEYS = ['name', 'title', 'company', 'email', 'phone', 'website', 'note'] as const;

/** Accepts an object, a JSON string (multipart forms), or null/empty. Empty fields are dropped; nothing left = null. */
export const signatureSchema = z.preprocess((v) => {
  if (typeof v === 'string') {
    if (!v.trim()) return null;
    try {
      return JSON.parse(v);
    } catch {
      return 'bad';
    }
  }
  return v;
}, z.union([z.null(), shape]).transform((s): Signature | null => {
  if (!s) return null;
  const out: Signature = {};
  for (const k of KEYS) if (s[k]) out[k] = s[k];
  return Object.keys(out).length ? out : null;
}));
