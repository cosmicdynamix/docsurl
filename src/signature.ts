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
  note: short(500),
});

export type NotePart = { text: string; href?: string };

const NOTE_RE = /<a\s+href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>|\[([^\]]{1,100})\]\(([^)\s]+)\)|https?:\/\/[^\s<>"']+|[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/gi;
const safeHref = (h: string): string | null => (/^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(h.trim()) ? h.trim() : null);

/** Split a note into plain text and links. Only <a href>, [text](url), bare URLs and emails become links (http, https, mailto); all other markup stays plain text. */
export function parseNote(note: string): NotePart[] {
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

const KEYS =['name', 'title', 'company', 'email', 'phone', 'website', 'note'] as const;

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
