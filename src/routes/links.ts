import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import QRCode from 'qrcode';
import { z } from 'zod';
import { audit, requireAuth } from '../auth.js';
import { pool } from '../db.js';
import { hashPassword } from '../passwords.js';
import { PdfError, type RenderedPdf, renderPdf } from '../pdf.js';
import { generateSlug, slugSchema } from '../slug.js';
import { stampText } from '../stamp.js';
import { type Variant, linkDir, originalPath, removeDir, tmpDir, variantDir, versionDir } from '../storage.js';

const idParam = z.object({ id: z.string().uuid() });
const linkPasswordSchema = z.string().min(4, 'Link password must be at least 4 characters').max(200);
const urlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Only http or https addresses can be shortened');
const optionalDate = z.union([z.string().datetime({ offset: true }), z.null()]).optional();
const optionalMaxViews = z.union([z.number().int().positive().max(10_000_000), z.null()]).optional();
const recipientSchema = z.union([z.string().trim().max(200), z.null()]).optional();
/** Accepts true/false, "1"/"0", "true"/"false". */
const boolish = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true')])
  .optional();
const tagsSchema = z.array(z.string().min(1).max(30)).max(10).optional();

/** Normalize tags: accepts "a, b" or ["a","b"]; lowercases, trims, dedupes. */
function parseTags(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v : String(v).split(',');
  const out = list.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
  return [...new Set(out)];
}

export function baseUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.headers.host ?? req.hostname}`;
}

/** SQL fragment: effective status of a link. */
const EFFECTIVE = `case when l.status = 'disabled' then 'disabled'
  when l.expires_at is not null and l.expires_at <= now() then 'expired'
  when l.max_views is not null and (select count(*) from views v where v.link_id = l.id and not v.is_bot and not v.is_owner_preview) >= l.max_views then 'expired'
  else 'active' end`;

const LINK_SELECT = `
  select l.id, l.slug, l.kind, l.title, l.status, l.destination_url as "destinationUrl",
         (l.password_hash is not null) as "hasPassword", l.expires_at as "expiresAt", l.max_views as "maxViews",
         l.recipient, l.tags, l.stamp,
         l.created_at as "createdAt", l.updated_at as "updatedAt", l.owner_id as "ownerId", u.email as "ownerEmail",
         ${EFFECTIVE} as "effectiveStatus",
         (select count(*)::int from views v where v.link_id = l.id and not v.is_bot and not v.is_owner_preview) as views,
         cv.version_no as "versionNo",
         df.page_count as "pageCount", df.size_bytes as "sizeBytes", df.original_name as "originalName",
         (mf.version_id is not null) as "hasMobile", mf.page_count as "mobilePageCount", mf.original_name as "mobileName"
    from links l
    join users u on u.id = l.owner_id
    left join link_versions cv on cv.id = l.current_version_id
    left join version_files df on df.version_id = cv.id and df.variant = 'desktop'
    left join version_files mf on mf.version_id = cv.id and mf.variant = 'mobile'`;

async function getAccessible(req: FastifyRequest, reply: FastifyReply, id: string) {
  const { rows } = await pool.query(`${LINK_SELECT} where l.id = $1`, [id]);
  const link = rows[0];
  if (!link || (req.user!.role !== 'admin' && link.ownerId !== req.user!.id)) {
    reply.code(404).send({ error: 'not_found' });
    return null;
  }
  return link;
}

/* ------------------------------------------------------------------ uploads */

interface UploadedFile {
  tmpFile: string;
  originalName: string;
  sha256: string;
  size: number;
}

interface Upload {
  fields: Record<string, string>;
  /** "desktop" also receives the plain `file` field; "mobile" is the optional second PDF. */
  files: Partial<Record<Variant, UploadedFile>>;
}

const emptyUpload = (): Upload => ({ fields: {}, files: {} });

/** Stream a multipart request: text fields + up to two PDFs (fields `desktop`/`file` and `mobile`) saved in the tmp dir. */
async function readUpload(req: FastifyRequest): Promise<Upload> {
  const up = emptyUpload();
  await mkdir(tmpDir, { recursive: true });
  try {
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        up.fields[part.fieldname] = String(part.value);
        continue;
      }
      const file = part as MultipartFile;
      const slot: Variant | null = file.fieldname === 'mobile' ? 'mobile' : file.fieldname === 'file' || file.fieldname === 'desktop' ? 'desktop' : null;
      if (!slot || up.files[slot]) {
        file.file.resume();
        continue;
      }
      const tmp = path.join(tmpDir, `${randomUUID()}.upload`);
      const hash = createHash('sha256');
      let size = 0;
      file.file.on('data', (c: Buffer) => {
        size += c.length;
        hash.update(c);
      });
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) {
        await unlink(tmp).catch(() => {});
        throw new PdfError('file_too_large');
      }
      up.files[slot] = { tmpFile: tmp, originalName: (file.filename ?? 'document.pdf').slice(0, 200), sha256: hash.digest('hex'), size };
    }
  } catch (e) {
    await discard(up);
    throw e;
  }
  return up;
}

/** Delete any temp files that were not moved into place. */
async function discard(up: Upload): Promise<void> {
  for (const f of Object.values(up.files)) if (f?.tmpFile) await unlink(f.tmpFile).catch(() => {});
}

const PDF_ERRORS: Record<string, number> = {
  not_a_pdf: 400,
  pdf_unreadable: 400,
  pdf_encrypted: 400,
  too_many_pages: 400,
  pdf_timeout: 422,
  pdf_render_failed: 422,
  file_too_large: 413,
  busy: 409,
};

function sendPdfError(reply: FastifyReply, e: unknown) {
  if (e instanceof PdfError) return reply.code(PDF_ERRORS[e.code] ?? 400).send({ error: e.code });
  throw e;
}

/* ----------------------------------------------------------------- variants */

interface StoredVariant {
  variant: Variant;
  originalName: string | null;
  sha256: string;
  size: number;
  rendered: RenderedPdf;
}

/** Move an uploaded PDF into its variant directory and render (and stamp) its pages. */
async function storeUploaded(linkId: string, versionNo: number, variant: Variant, f: UploadedFile, stamp: string | null): Promise<StoredVariant> {
  const dir = variantDir(linkId, versionNo, variant);
  await mkdir(dir, { recursive: true });
  await rename(f.tmpFile, originalPath(linkId, versionNo, variant));
  f.tmpFile = '';
  // og.jpg (link-preview card) always comes from the desktop/default file
  const rendered = await renderPdf(originalPath(linkId, versionNo, variant), dir, { stamp, og: variant === 'desktop' });
  return { variant, originalName: f.originalName, sha256: f.sha256, size: f.size, rendered };
}

/** Copy a variant (original + stamped pages + preview) from an older version into a new one. */
async function carryOver(linkId: string, fromNo: number, toNo: number, variant: Variant, client: PoolClient, fromVersionId: string, toVersionId: string): Promise<void> {
  const src = variantDir(linkId, fromNo, variant);
  const dst = variantDir(linkId, toNo, variant);
  await mkdir(dst, { recursive: true });
  await cp(path.join(src, 'original.pdf'), path.join(dst, 'original.pdf'));
  await cp(path.join(src, 'pages'), path.join(dst, 'pages'), { recursive: true });
  if (variant === 'desktop') await cp(path.join(src, 'og.jpg'), path.join(dst, 'og.jpg')).catch(() => {});
  await client.query(
    `insert into version_files(version_id, variant, original_name, page_count, file_sha256, size_bytes)
     select $2, variant, original_name, page_count, file_sha256, size_bytes from version_files where version_id = $1 and variant = $3`,
    [fromVersionId, toVersionId, variant],
  );
  await client.query(
    `insert into link_pages(version_id, variant, page_no, width, height)
     select $2, variant, page_no, width, height from link_pages where version_id = $1 and variant = $3`,
    [fromVersionId, toVersionId, variant],
  );
}

async function insertVariant(client: PoolClient, versionId: string, s: StoredVariant): Promise<void> {
  await client.query(
    'insert into version_files(version_id, variant, original_name, page_count, file_sha256, size_bytes) values ($1,$2,$3,$4,$5,$6)',
    [versionId, s.variant, s.originalName, s.rendered.pageCount, s.sha256, s.size],
  );
  for (let i = 0; i < s.rendered.pages.length; i++) {
    await client.query('insert into link_pages(version_id, variant, page_no, width, height) values ($1,$2,$3,$4,$5)', [
      versionId,
      s.variant,
      i + 1,
      s.rendered.pages[i].width,
      s.rendered.pages[i].height,
    ]);
  }
}

const restamping = new Set<string>();

/** Re-render every stored version and variant of a link with the current stamp setting (originals stay untouched). */
async function restamp(linkId: string): Promise<void> {
  if (restamping.has(linkId)) throw new PdfError('busy');
  restamping.add(linkId);
  try {
    const l = (await pool.query<{ recipient: string | null; stamp: boolean }>('select recipient, stamp from links where id = $1', [linkId])).rows[0];
    if (!l) return;
    const text = l.recipient && l.stamp ? stampText(l.recipient) : null;
    const files = (
      await pool.query<{ version_no: number; variant: Variant }>(
        `select v.version_no, f.variant from link_versions v join version_files f on f.version_id = v.id
          where v.link_id = $1 order by v.version_no, f.variant`,
        [linkId],
      )
    ).rows;
    for (const f of files) {
      const dir = variantDir(linkId, f.version_no, f.variant);
      const fresh = path.join(dir, 'pages.new');
      await removeDir(fresh);
      await renderPdf(originalPath(linkId, f.version_no, f.variant), dir, { stamp: text, pagesSubdir: 'pages.new', og: false });
      await removeDir(path.join(dir, 'pages'));
      await rename(fresh, path.join(dir, 'pages'));
    }
  } finally {
    restamping.delete(linkId);
  }
}

export async function linkRoutes(app: FastifyInstance): Promise<void> {
  // List: users see their own, admins see everything.
  app.get('/api/links', { preHandler: requireAuth }, async (req) => {
    const admin = req.user!.role === 'admin';
    const { rows } = await pool.query(
      `${LINK_SELECT} ${admin ? '' : 'where l.owner_id = $1'} order by l.created_at desc limit 500`,
      admin ? [] : [req.user!.id],
    );
    return { links: rows };
  });

  app.get('/api/links/:id', { preHandler: requireAuth }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const link = await getAccessible(req, reply, p.data.id);
    if (!link) return;
    const versions = (
      await pool.query(
        `select v.id, v.version_no as "versionNo", v.original_name as "originalName", v.page_count as "pageCount",
                v.size_bytes as "sizeBytes", v.note, v.uploaded_at as "uploadedAt", u.email as "uploadedBy",
                (v.id = l.current_version_id) as current,
                (select coalesce(json_agg(json_build_object('variant', f.variant, 'originalName', f.original_name,
                          'pageCount', f.page_count, 'sizeBytes', f.size_bytes) order by f.variant), '[]'::json)
                   from version_files f where f.version_id = v.id) as files
           from link_versions v join links l on l.id = v.link_id left join users u on u.id = v.uploaded_by
          where v.link_id = $1 order by v.version_no desc`,
        [p.data.id],
      )
    ).rows;
    return { link, versions, url: `${baseUrl(req)}/${link.slug}` };
  });

  // Create: multipart for files (field "kind"=file), JSON for URL shortening.
  app.post('/api/links', { preHandler: requireAuth }, async (req, reply) => {
    const isMultipart = req.isMultipart();
    let up = emptyUpload();
    let raw: Record<string, unknown>;
    try {
      if (isMultipart) {
        up = await readUpload(req);
        raw = { ...up.fields };
        if (raw.maxViews === '' || raw.maxViews === undefined) raw.maxViews = null;
        else raw.maxViews = Number(raw.maxViews);
        raw.expiresAt = raw.expiresAt ? raw.expiresAt : null;
        raw.password = raw.password ? raw.password : undefined;
        raw.slug = raw.slug ? raw.slug : undefined;
        raw.recipient = raw.recipient ? raw.recipient : null;
        raw.tags = parseTags(raw.tags);
      } else {
        raw = (req.body ?? {}) as Record<string, unknown>;
        raw.tags = parseTags(raw.tags);
        raw.recipient = raw.recipient ? raw.recipient : null;
        raw.slug = raw.slug ? raw.slug : undefined;
        raw.password = raw.password ? raw.password : undefined;
      }
    } catch (e) {
      return sendPdfError(reply, e);
    }

    const parsed = z
      .object({
        kind: z.enum(['file', 'url']),
        title: z.string().trim().min(1, 'Title is required').max(200),
        slug: slugSchema.optional(),
        password: linkPasswordSchema.optional(),
        recipient: recipientSchema,
        stamp: boolish,
        tags: tagsSchema,
        expiresAt: optionalDate,
        maxViews: optionalMaxViews,
        destinationUrl: urlSchema.optional(),
      })
      .safeParse(raw);
    if (!parsed.success) {
      await discard(up);
      return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    if (d.expiresAt && new Date(d.expiresAt) <= new Date()) {
      await discard(up);
      return reply.code(400).send({ error: 'expiry_in_past' });
    }
    if (d.kind === 'file' && !up.files.desktop && !up.files.mobile) return reply.code(400).send({ error: 'file_required' });
    if (d.kind === 'url' && !d.destinationUrl) {
      await discard(up);
      return reply.code(400).send({ error: 'destination_required' });
    }
    if (d.kind === 'url') await discard(up);
    if (d.kind === 'url' && d.password) return reply.code(400).send({ error: 'password_not_supported_for_url' });

    const slug = d.slug ?? (await generateSlug());
    if ((await pool.query('select 1 from links where slug = $1', [slug])).rowCount) {
      await discard(up);
      return reply.code(409).send({ error: 'slug_taken' });
    }

    const linkId = randomUUID();
    const pwHash = d.password ? await hashPassword(d.password) : null;

    if (d.kind === 'url') {
      await pool.query(
        `insert into links(id, owner_id, slug, kind, title, destination_url, expires_at, max_views, recipient, tags, stamp)
         values ($1,$2,$3,'url',$4,$5,$6,$7,$8,$9,$10)`,
        [linkId, req.user!.id, slug, d.title, d.destinationUrl, d.expiresAt ?? null, d.maxViews ?? null, d.recipient || null, d.tags ?? [], d.stamp !== false],
      );
      await audit(req, 'link.created', 'link', linkId, { slug, kind: 'url' });
      return { id: linkId, slug, url: `${baseUrl(req)}/${slug}` };
    }

    // File link. With two PDFs they become the desktop and mobile variants; with one PDF it is used on every device.
    const desktopFile = up.files.desktop ?? up.files.mobile!;
    const mobileFile = up.files.desktop && up.files.mobile ? up.files.mobile : undefined;
    const stamp = d.recipient && d.stamp !== false ? stampText(d.recipient) : null;
    const stored: StoredVariant[] = [];
    try {
      stored.push(await storeUploaded(linkId, 1, 'desktop', desktopFile, stamp));
      if (mobileFile) stored.push(await storeUploaded(linkId, 1, 'mobile', mobileFile, stamp));
    } catch (e) {
      await discard(up);
      await removeDir(linkDir(linkId));
      return sendPdfError(reply, e);
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into links(id, owner_id, slug, kind, title, password_hash, expires_at, max_views, recipient, tags, stamp)
         values ($1,$2,$3,'file',$4,$5,$6,$7,$8,$9,$10)`,
        [linkId, req.user!.id, slug, d.title, pwHash, d.expiresAt ?? null, d.maxViews ?? null, d.recipient || null, d.tags ?? [], d.stamp !== false],
      );
      const versionId = randomUUID();
      const main = stored[0];
      await client.query(
        `insert into link_versions(id, link_id, version_no, original_name, page_count, file_sha256, size_bytes, uploaded_by)
         values ($1,$2,1,$3,$4,$5,$6,$7)`,
        [versionId, linkId, main.originalName, main.rendered.pageCount, main.sha256, main.size, req.user!.id],
      );
      for (const s of stored) await insertVariant(client, versionId, s);
      await client.query('update links set current_version_id = $2 where id = $1', [linkId, versionId]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      await removeDir(linkDir(linkId));
      throw e;
    } finally {
      client.release();
    }
    await audit(req, 'link.created', 'link', linkId, { slug, kind: 'file', pages: stored[0].rendered.pageCount, mobile: !!mobileFile });
    return { id: linkId, slug, url: `${baseUrl(req)}/${slug}` };
  });

  app.patch('/api/links/:id', { preHandler: requireAuth }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const link = await getAccessible(req, reply, p.data.id);
    if (!link) return;
    const body = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        recipient: recipientSchema,
        stamp: boolish,
        tags: tagsSchema,
        slug: slugSchema.optional(),
        status: z.enum(['active', 'disabled']).optional(),
        password: z.union([linkPasswordSchema, z.null()]).optional(), // null = remove
        expiresAt: optionalDate,
        maxViews: optionalMaxViews,
        destinationUrl: urlSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() });
    const d = body.data;
    if (d.password && link.kind === 'url') return reply.code(400).send({ error: 'password_not_supported_for_url' });
    if (d.destinationUrl && link.kind !== 'url') return reply.code(400).send({ error: 'invalid' });
    if (d.slug && d.slug !== link.slug && (await pool.query('select 1 from links where slug = $1', [d.slug])).rowCount)
      return reply.code(409).send({ error: 'slug_taken' });

    const sets: string[] = ['updated_at = now()'];
    const vals: unknown[] = [p.data.id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (d.title !== undefined) set('title', d.title);
    if (d.recipient !== undefined) set('recipient', d.recipient || null);
    if (d.stamp !== undefined) set('stamp', d.stamp);
    if (d.tags !== undefined) set('tags', d.tags);
    if (d.slug !== undefined) set('slug', d.slug);
    if (d.status !== undefined) set('status', d.status);
    if (d.expiresAt !== undefined) set('expires_at', d.expiresAt);
    if (d.maxViews !== undefined) set('max_views', d.maxViews);
    if (d.destinationUrl !== undefined) set('destination_url', d.destinationUrl);
    if (d.password !== undefined) set('password_hash', d.password === null ? null : await hashPassword(d.password));
    await pool.query(`update links set ${sets.join(', ')} where id = $1`, vals);
    // The stamp is burned into the page images, so changing the recipient or the toggle re-renders them.
    const newRecipient = d.recipient !== undefined ? d.recipient || null : link.recipient;
    const newStamp = d.stamp ?? link.stamp;
    if (link.kind === 'file' && (newRecipient !== link.recipient || newStamp !== link.stamp)) {
      try {
        await restamp(p.data.id);
      } catch (e) {
        return sendPdfError(reply, e);
      }
    }
    await audit(req, 'link.updated', 'link', p.data.id, {
      ...d,
      password: d.password === undefined ? undefined : d.password === null ? 'removed' : 'set',
    });
    return { ok: true };
  });

  app.delete('/api/links/:id', { preHandler: requireAuth }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const link = await getAccessible(req, reply, p.data.id);
    if (!link) return;
    await pool.query('delete from links where id = $1', [p.data.id]);
    await removeDir(linkDir(p.data.id));
    await audit(req, 'link.deleted', 'link', p.data.id, { slug: link.slug });
    return { ok: true };
  });

  /**
   * New version of a file link ("replace file"): same slug, same stats.
   * Fields: `desktop` (or `file`) and/or `mobile` PDFs, optional `note`, optional `removeMobile=1`.
   * Variants that are not uploaded are carried over unchanged from the live version.
   */
  app.post('/api/links/:id/versions', { preHandler: requireAuth }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const link = await getAccessible(req, reply, p.data.id);
    if (!link) return;
    if (link.kind !== 'file') return reply.code(400).send({ error: 'invalid' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'file_required' });

    let up: Upload;
    try {
      up = await readUpload(req);
    } catch (e) {
      return sendPdfError(reply, e);
    }
    const removeMobile = ['1', 'true'].includes(up.fields.removeMobile ?? '');
    if (!up.files.desktop && !up.files.mobile && !(removeMobile && link.hasMobile)) {
      return reply.code(400).send({ error: 'file_required' });
    }

    const live = (
      await pool.query<{ id: string; version_no: number; variants: Variant[] }>(
        `select v.id, v.version_no, array(select variant from version_files where version_id = v.id) as variants
           from links l join link_versions v on v.id = l.current_version_id where l.id = $1`,
        [p.data.id],
      )
    ).rows[0];
    if (!live) {
      await discard(up);
      return reply.code(409).send({ error: 'invalid' });
    }

    const next =
      (await pool.query('select coalesce(max(version_no), 0) + 1 as n from link_versions where link_id = $1', [p.data.id]))
        .rows[0].n as number;
    const stamp = link.recipient && link.stamp ? stampText(link.recipient) : null;
    const stored: StoredVariant[] = [];
    try {
      if (up.files.desktop) stored.push(await storeUploaded(p.data.id, next, 'desktop', up.files.desktop, stamp));
      if (up.files.mobile) stored.push(await storeUploaded(p.data.id, next, 'mobile', up.files.mobile, stamp));
    } catch (e) {
      await discard(up);
      await removeDir(versionDir(p.data.id, next));
      return sendPdfError(reply, e);
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      const versionId = randomUUID();
      // Desktop file metadata lives on the version row too (kept for older queries and listings)
      const newDesktop = stored.find((s) => s.variant === 'desktop');
      let meta: { original_name: string | null; page_count: number; file_sha256: string; size_bytes: string };
      if (newDesktop) {
        meta = { original_name: newDesktop.originalName, page_count: newDesktop.rendered.pageCount, file_sha256: newDesktop.sha256, size_bytes: String(newDesktop.size) };
      } else {
        meta = (
          await client.query(
            'select original_name, page_count, file_sha256, size_bytes from version_files where version_id = $1 and variant = $2',
            [live.id, 'desktop'],
          )
        ).rows[0];
      }
      await client.query(
        `insert into link_versions(id, link_id, version_no, original_name, page_count, file_sha256, size_bytes, note, uploaded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [versionId, p.data.id, next, meta.original_name, meta.page_count, meta.file_sha256, meta.size_bytes, (up.fields.note ?? '').slice(0, 300) || null, req.user!.id],
      );
      for (const s of stored) await insertVariant(client, versionId, s);
      // Carry over what was not replaced (mobile can be dropped explicitly)
      for (const variant of ['desktop', 'mobile'] as const) {
        if (stored.some((s) => s.variant === variant)) continue;
        if (variant === 'mobile' && removeMobile) continue;
        if (!live.variants.includes(variant)) continue;
        await carryOver(p.data.id, live.version_no, next, variant, client, live.id, versionId);
      }
      await client.query('update links set current_version_id = $2, updated_at = now() where id = $1', [p.data.id, versionId]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      await removeDir(versionDir(p.data.id, next));
      throw e;
    } finally {
      client.release();
    }
    await audit(req, 'link.version_added', 'link', p.data.id, { versionNo: next, replaced: stored.map((s) => s.variant), removeMobile });
    return { ok: true, versionNo: next };
  });

  app.post('/api/links/:id/versions/:versionId/activate', { preHandler: requireAuth }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), versionId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const link = await getAccessible(req, reply, p.data.id);
    if (!link) return;
    const { rowCount } = await pool.query(
      'update links set current_version_id = $2, updated_at = now() where id = $1 and exists (select 1 from link_versions where id = $2 and link_id = $1)',
      [p.data.id, p.data.versionId],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(req, 'link.version_activated', 'link', p.data.id, { versionId: p.data.versionId });
    return { ok: true };
  });

  app.get('/api/links/:id/qr.svg', { preHandler: requireAuth }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const link = await getAccessible(req, reply, p.data.id);
    if (!link) return;
    const svg = await QRCode.toString(`${baseUrl(req)}/${link.slug}`, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    return reply.type('image/svg+xml').send(svg);
  });
}
