import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { audit, requireAdmin } from '../auth.js';
import { DEFAULT_SITE_NAME, getBranding, setSetting } from '../branding.js';
import { config } from '../config.js';

const brandDir = path.join(path.resolve(config.dataDir), 'brand');
const MAX_LOGO_BYTES = 1024 * 1024;
const MAX_SVG_BYTES = 512 * 1024;
const variantSchema = z.enum(['dark', 'light']);
const ICON_SIZES = [180, 192, 512] as const;
const ICON_BG = '#0B0D12';
const MIME: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml' };

export const siteNameSchema = z.string().trim().min(1, 'System name is required').max(60, 'System name is too long');

/**
 * Logos are served from our own origin, so SVGs must not be able to run script or pull in
 * external resources. We reject anything beyond plain vector artwork (and serve with a sandbox CSP as well).
 */
export function checkSvg(text: string): string | null {
  if (!/<svg[\s>]/i.test(text)) return 'not_an_svg';
  if (/<script|<foreignObject|<iframe|<object|<embed|<audio|<video|<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text)) return 'svg_unsafe';
  if (/\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text)) return 'svg_unsafe';
  if (/(?:xlink:)?href\s*=\s*["'](?!#)/i.test(text)) return 'svg_external_reference';
  if (/@import|url\(\s*["']?(?!#)/i.test(text)) return 'svg_external_reference';
  return null;
}

async function removeLogoFiles(variant: string): Promise<void> {
  try {
    for (const f of await readdir(brandDir)) if (f.startsWith(`logo-${variant}.`)) await rm(path.join(brandDir, f), { force: true });
  } catch {
    /* directory does not exist yet */
  }
}

const iconFile = (size: number): string => `app-icon-${size}.png`;
const defaultIcons = new Map<number, Buffer>();

/** Neutral placeholder icon (the default logo mark on the dark brand background). */
async function defaultIcon(size: number): Promise<Buffer> {
  let out = defaultIcons.get(size);
  if (!out) {
    const svg = await readFile(path.join(path.resolve(config.webDir), 'brand', 'default-dark.svg'));
    const mark = await sharp(svg, { density: 600 }).resize(Math.round(size * 0.56), Math.round(size * 0.56)).png().toBuffer();
    out = await sharp({ create: { width: size, height: size, channels: 4, background: ICON_BG } })
      .composite([{ input: mark, gravity: 'center' }])
      .png()
      .toBuffer();
    defaultIcons.set(size, out);
  }
  return out;
}

async function removeIconFiles(): Promise<void> {
  for (const s of ICON_SIZES) await rm(path.join(brandDir, iconFile(s)), { force: true });
}

export const manifestShortName = (name: string): string => (name.length > 12 ? name.slice(0, 12).trimEnd() : name);

const publicBranding = () => {
  const b = getBranding();
  return { siteName: b.siteName, hasLogoDark: !!b.logoDark, hasLogoLight: !!b.logoLight, version: b.version, hasAppIcon: !!b.appIcon, hasBackground: !!b.bgImage };
};

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Public: needed by the sign-in screen and the public viewer.
  app.get('/api/branding', async () => publicBranding());

  app.get('/brand/logo/:variant', async (req, reply) => {
    const v = variantSchema.safeParse((req.params as { variant: string }).variant);
    if (!v.success) return reply.code(404).send();
    const b = getBranding();
    // A single uploaded logo is used for both themes.
    const name = v.data === 'dark' ? (b.logoDark ?? b.logoLight) : (b.logoLight ?? b.logoDark);
    let body: Buffer | null = null;
    let type = 'image/svg+xml';
    if (name) {
      try {
        body = await readFile(path.join(brandDir, name));
        type = MIME[path.extname(name)] ?? 'application/octet-stream';
      } catch {
        body = null;
      }
    }
    if (!body) body = await readFile(path.join(path.resolve(config.webDir), 'brand', `default-${v.data}.svg`));
    return reply
      .header('Content-Type', type)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('Cache-Control', 'public, max-age=3600')
      .send(body);
  });

  // Public: the web app manifest and the home-screen icons ("Add to Home Screen" / "Install app").
  app.get('/manifest.webmanifest', async (_req, reply) => {
    const b = getBranding();
    const icons = [192, 512].map((s) => ({ src: `/brand/icon/${s}?v=${b.version}`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any' }));
    return reply
      .header('Content-Type', 'application/manifest+json')
      .header('Cache-Control', 'public, max-age=300')
      .send({
        name: b.siteName,
        short_name: manifestShortName(b.siteName),
        start_url: '/app/',
        scope: '/app/',
        display: 'standalone',
        background_color: ICON_BG,
        theme_color: ICON_BG,
        icons,
      });
  });

  app.get('/brand/background', async (_req, reply) => {
    const name = getBranding().bgImage;
    if (!name) return reply.code(404).send();
    try {
      const body = await readFile(path.join(brandDir, name));
      return reply.header('Content-Type', 'image/jpeg').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'public, max-age=86400').send(body);
    } catch {
      return reply.code(404).send();
    }
  });

  app.get('/brand/icon/:size', async (req, reply) => {
    const size = Number((req.params as { size: string }).size);
    if (!(ICON_SIZES as readonly number[]).includes(size)) return reply.code(404).send();
    let body: Buffer;
    try {
      body = getBranding().appIcon ? await readFile(path.join(brandDir, iconFile(size))) : await defaultIcon(size);
    } catch {
      body = await defaultIcon(size);
    }
    return reply.header('Content-Type', 'image/png').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'public, max-age=3600').send(body);
  });

  app.get('/api/settings', { preHandler: requireAdmin }, async () => publicBranding());

  app.patch('/api/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const body = z.object({ siteName: siteNameSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() });
    await setSetting('site_name', body.data.siteName);
    await audit(req, 'settings.site_name', 'settings', 'site_name', { siteName: body.data.siteName });
    return publicBranding();
  });

  app.post('/api/settings/logo/:variant', { preHandler: requireAdmin }, async (req, reply) => {
    const v = variantSchema.safeParse((req.params as { variant: string }).variant);
    if (!v.success) return reply.code(400).send({ error: 'invalid' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'file_required' });
    let buf: Buffer;
    try {
      const file = await req.file({ limits: { fileSize: MAX_LOGO_BYTES, files: 1 } });
      if (!file) return reply.code(400).send({ error: 'file_required' });
      buf = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'logo_too_large' });
    }

    let out: Buffer;
    let ext: '.png' | '.svg';
    const head = buf.subarray(0, 512).toString('utf8').trimStart();
    if (/^(<\?xml|<svg|<!--|<!doctype svg)/i.test(head)) {
      if (buf.length > MAX_SVG_BYTES) return reply.code(413).send({ error: 'logo_too_large' });
      const problem = checkSvg(buf.toString('utf8'));
      if (problem) return reply.code(400).send({ error: problem });
      out = buf;
      ext = '.svg';
    } else {
      try {
        const meta = await sharp(buf, { limitInputPixels: 50_000_000 }).metadata();
        if (!meta.format || !['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) return reply.code(400).send({ error: 'logo_bad_format' });
        // Re-encode: strips metadata and normalizes size (retina-friendly for a 28-48 px display height).
        out = await sharp(buf, { limitInputPixels: 50_000_000 }).rotate().resize({ height: 192, withoutEnlargement: true }).png().toBuffer();
        ext = '.png';
      } catch {
        return reply.code(400).send({ error: 'logo_bad_format' });
      }
    }

    await mkdir(brandDir, { recursive: true });
    await removeLogoFiles(v.data);
    const name = `logo-${v.data}${ext}`;
    await writeFile(path.join(brandDir, name), out);
    await setSetting(`logo_${v.data}`, name);
    await audit(req, 'settings.logo_uploaded', 'settings', `logo_${v.data}`, { bytes: out.length, type: ext });
    return publicBranding();
  });

  app.post('/api/settings/app-icon', { preHandler: requireAdmin }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'file_required' });
    let buf: Buffer;
    try {
      const file = await req.file({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
      if (!file) return reply.code(400).send({ error: 'file_required' });
      buf = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'logo_too_large' });
    }
    const outputs = new Map<number, Buffer>();
    try {
      const meta = await sharp(buf, { limitInputPixels: 50_000_000 }).metadata();
      if (!meta.format || !['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) return reply.code(400).send({ error: 'logo_bad_format' });
      if ((meta.width ?? 0) < 192 || (meta.height ?? 0) < 192) return reply.code(400).send({ error: 'icon_too_small' });
      for (const s of ICON_SIZES) {
        // Cover-crop to a square; flatten onto the brand background because iOS renders transparency as black.
        outputs.set(
          s,
          await sharp(buf, { limitInputPixels: 50_000_000 }).rotate().resize(s, s, { fit: 'cover' }).flatten({ background: ICON_BG }).png().toBuffer(),
        );
      }
    } catch {
      return reply.code(400).send({ error: 'logo_bad_format' });
    }
    await mkdir(brandDir, { recursive: true });
    for (const [s, out] of outputs) await writeFile(path.join(brandDir, iconFile(s)), out);
    await setSetting('app_icon', iconFile(512));
    await audit(req, 'settings.app_icon_uploaded', 'settings', 'app_icon');
    return publicBranding();
  });

  app.post('/api/settings/background', { preHandler: requireAdmin }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'file_required' });
    let buf: Buffer;
    try {
      const file = await req.file({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
      if (!file) return reply.code(400).send({ error: 'file_required' });
      buf = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'logo_too_large' });
    }
    let out: Buffer;
    try {
      const meta = await sharp(buf, { limitInputPixels: 80_000_000 }).metadata();
      if (!meta.format || !['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) return reply.code(400).send({ error: 'logo_bad_format' });
      out = await sharp(buf, { limitInputPixels: 80_000_000 })
        .rotate()
        .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: ICON_BG })
        .jpeg({ quality: 82, progressive: true })
        .toBuffer();
    } catch {
      return reply.code(400).send({ error: 'logo_bad_format' });
    }
    await mkdir(brandDir, { recursive: true });
    await writeFile(path.join(brandDir, 'background.jpg'), out);
    await setSetting('bg_image', 'background.jpg');
    await audit(req, 'settings.background_uploaded', 'settings', 'bg_image', { bytes: out.length });
    return publicBranding();
  });

  app.delete('/api/settings/background', { preHandler: requireAdmin }, async (req) => {
    await rm(path.join(brandDir, 'background.jpg'), { force: true });
    await setSetting('bg_image', null);
    await audit(req, 'settings.background_removed', 'settings', 'bg_image');
    return publicBranding();
  });

  app.delete('/api/settings/app-icon', { preHandler: requireAdmin }, async (req) => {
    await removeIconFiles();
    await setSetting('app_icon', null);
    await audit(req, 'settings.app_icon_removed', 'settings', 'app_icon');
    return publicBranding();
  });

  app.delete('/api/settings/logo/:variant', { preHandler: requireAdmin }, async (req, reply) => {
    const v = variantSchema.safeParse((req.params as { variant: string }).variant);
    if (!v.success) return reply.code(400).send({ error: 'invalid' });
    await removeLogoFiles(v.data);
    await setSetting(`logo_${v.data}`, null);
    await audit(req, 'settings.logo_removed', 'settings', `logo_${v.data}`);
    return publicBranding();
  });
}

export { DEFAULT_SITE_NAME };
