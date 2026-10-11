import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

export interface PdfImagePage {
  file: string;
}

/** Longest page edge in PDF points (A4/Letter-ish); the stored JPEGs are scaled to this. */
const LONG_EDGE_PT = 792;

/**
 * Builds a PDF whose pages are the given JPEG files (embedded as-is). Used for downloads of stamped documents,
 * so the "Confidential — for …" stamp is part of the downloaded copy. The result is image-only (no selectable text).
 */
export async function imagesToPdf(pages: PdfImagePage[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Buffer | string): void => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    chunks.push(buf);
    size += buf.length;
  };
  const obj = (n: number, body: Buffer | string): void => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const total = 2 + pages.length * 3; // catalog, pages, then (page, content, image) per page
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  for (let i = 0; i < pages.length; i++) {
    let jpeg = await readFile(pages[i].file);
    let meta = await sharp(jpeg).metadata();
    if (meta.channels !== 1 && meta.channels !== 3) {
      jpeg = await sharp(jpeg).toColorspace('srgb').removeAlpha().jpeg({ quality: 88 }).toBuffer();
      meta = await sharp(jpeg).metadata();
    }
    const w = meta.width ?? 1;
    const h = meta.height ?? 1;
    const k = LONG_EDGE_PT / Math.max(w, h);
    const pw = +(w * k).toFixed(2);
    const ph = +(h * k).toFixed(2);
    const pageN = 3 + i * 3;
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(pageN, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${pageN + 2} 0 R >> >> /Contents ${pageN + 1} 0 R >>`);
    obj(pageN + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[pageN + 2] = size;
    push(`${pageN + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${meta.channels === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push('\nendstream\nendobj\n');
  }

  const xref = size;
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
