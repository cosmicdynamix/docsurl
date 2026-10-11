import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { stampImage } from './stamp.js';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 200_000) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 20_000) stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export class PdfError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** Read width/height from a JPEG's SOF marker. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

export interface RenderedPdf {
  pageCount: number;
  pages: { width: number; height: number }[];
}

export interface RenderOptions {
  /** Text burned into the top-right corner of every page (e.g. "Confidential — for Jane"). */
  stamp?: string | null;
  /** Sub-directory for the page images (default "pages"). */
  pagesSubdir?: string;
  /** Also write the small og.jpg preview of page 1 (default true). */
  og?: boolean;
}

/**
 * Render every page of a PDF to JPEG (long side 1800 px), optionally stamped, plus a small og.jpg preview of page 1.
 * Output: <versionDir>/<pagesSubdir>/<n>.jpg and <versionDir>/og.jpg
 */
export async function renderPdf(pdfFile: string, versionDir: string, opts: RenderOptions = {}): Promise<RenderedPdf> {
  const head = (await readFile(pdfFile)).subarray(0, 8).toString('latin1');
  if (!head.startsWith('%PDF-')) throw new PdfError('not_a_pdf');

  const info = await run('pdfinfo', [pdfFile], 30_000);
  if (info.timedOut) throw new PdfError('pdf_timeout');
  if (info.code !== 0) throw new PdfError('pdf_unreadable');
  if (/^Encrypted:\s+yes/im.test(info.stdout)) throw new PdfError('pdf_encrypted');
  const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1] ?? 0);
  if (!pageCount) throw new PdfError('pdf_unreadable');
  if (pageCount > config.maxPages) throw new PdfError('too_many_pages');

  const pagesDir = path.join(versionDir, opts.pagesSubdir ?? 'pages');
  await mkdir(pagesDir, { recursive: true });

  const stamp = opts.stamp ?? null;
  // Stamped pages go through PNG so the image is only JPEG-compressed once.
  const out = await run(
    'pdftoppm',
    [stamp ? '-png' : '-jpeg', ...(stamp ? [] : ['-jpegopt', 'quality=82']), '-scale-to', '1800', pdfFile, path.join(pagesDir, 'p')],
    240_000,
  );
  if (out.timedOut) throw new PdfError('pdf_timeout');
  if (out.code !== 0) throw new PdfError('pdf_render_failed');

  // pdftoppm names files p-<zero padded n>.(jpg|png) -> final <n>.jpg
  const ext = stamp ? 'png' : 'jpg';
  const re = ext === 'png' ? /^p-(\d+)\.png$/ : /^p-(\d+)\.jpg$/;
  const files = (await readdir(pagesDir)).filter((f) => re.test(f));
  if (files.length !== pageCount) throw new PdfError('pdf_render_failed');
  const pages: RenderedPdf['pages'] = [];
  for (const f of files) {
    const n = Number(re.exec(f)![1]);
    const dest = path.join(pagesDir, `${n}.jpg`);
    if (stamp) {
      try {
        pages[n - 1] = await stampImage(path.join(pagesDir, f), dest, stamp);
      } catch {
        throw new PdfError('pdf_render_failed');
      }
      await rm(path.join(pagesDir, f), { force: true });
    } else {
      await rename(path.join(pagesDir, f), dest);
      const size = jpegSize(await readFile(dest));
      if (!size) throw new PdfError('pdf_render_failed');
      pages[n - 1] = size;
    }
  }

  // Small preview for link cards (WhatsApp etc. want < 300 KB). Never stamped.
  if (opts.og !== false) {
    const ogBase = path.join(versionDir, 'og');
    await run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=75', '-f', '1', '-l', '1', '-singlefile', '-scale-to', '630', pdfFile, ogBase], 60_000);
  }

  return { pageCount, pages };
}
