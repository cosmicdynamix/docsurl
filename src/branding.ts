import { pool } from './db.js';

export interface Branding {
  siteName: string;
  /** Logo for dark backgrounds (usually a light-colored logo). */
  logoDark: string | null;
  /** Logo for light backgrounds (usually a dark-colored logo). */
  logoLight: string | null;
  /** Square home-screen / app icon (PNG file name), if one was uploaded. */
  appIcon: string | null;
  /** Changes whenever branding changes; used to bust caches. */
  version: number;
}

export const DEFAULT_SITE_NAME = 'Docs';
let cache: Branding = { siteName: DEFAULT_SITE_NAME, logoDark: null, logoLight: null, appIcon: null, version: 0 };

export const getBranding = (): Branding => cache;

export async function loadBranding(): Promise<void> {
  const { rows } = await pool.query<{ key: string; value: string; updated_at: Date }>('select key, value, updated_at from settings');
  const m = new Map(rows.map((r) => [r.key, r]));
  cache = {
    siteName: m.get('site_name')?.value || DEFAULT_SITE_NAME,
    logoDark: m.get('logo_dark')?.value ?? null,
    logoLight: m.get('logo_light')?.value ?? null,
    appIcon: m.get('app_icon')?.value ?? null,
    version: rows.reduce((v, r) => Math.max(v, Math.floor(r.updated_at.getTime() / 1000)), 0),
  };
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  if (value === null) await pool.query('delete from settings where key = $1', [key]);
  else
    await pool.query(
      'insert into settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()',
      [key, value],
    );
  await loadBranding();
  // deleting the last row would reset the version to 0 and could serve stale cached logos; bump it
  if (cache.version === 0) cache = { ...cache, version: Math.floor(Date.now() / 1000) };
}
