import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.js';

// Paths owned by the application; never usable as a link slug.
export const RESERVED_SLUGS = new Set([
  'app', 'api', 'health', 'assets', 'static', 'login', 'logout', 'admin', 'favicon.ico', 'robots.txt',
  'sitemap.xml', 'manifest.json', 'manifest.webmanifest', 'sw.js', 'index', 'unlock', 'brand',
]);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{1,63}$/, 'Slug must be 2-64 characters: letters, numbers, hyphen or underscore')
  .refine((s) => !RESERVED_SLUGS.has(s) && !s.startsWith('_'), 'This slug is reserved, choose another one');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export async function generateSlug(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    let s = '';
    for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    const { rowCount } = await pool.query('select 1 from links where slug = $1', [s]);
    if (!rowCount) return s;
  }
  throw new Error('could not generate slug');
}
