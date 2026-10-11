import sharp from 'sharp';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text burned into the top-right corner of every page. */
export function stampText(recipient: string): string {
  return `Confidential — for ${recipient.trim().replace(/\s+/g, ' ').slice(0, 80)}`;
}

/**
 * Burn a "Confidential — for <name>" label into the top-right corner of a rendered page:
 * light-gray box, red bold text. Size scales with the page width so it looks the same on every document.
 */
export async function stampImage(srcPath: string, outJpg: string, text: string): Promise<{ width: number; height: number }> {
  const img = sharp(srcPath);
  const meta = await img.metadata();
  const W = meta.width!;
  const H = meta.height!;
  const fontPx = Math.max(12, Math.round(W * 0.0165));
  const pad = Math.round(fontPx * 0.6);
  const margin = Math.round(W * 0.015);

  const label = await sharp({
    text: {
      text: `<span foreground="#C62828" font_weight="bold">${esc(text)}</span>`,
      font: `DejaVu Sans ${fontPx}`,
      rgba: true,
      width: Math.round(W * 0.6),
      dpi: 72,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });

  const bw = label.info.width + pad * 2;
  const bh = label.info.height + pad * 2;
  const box = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}"><rect x="0.5" y="0.5" width="${bw - 1}" height="${bh - 1}" rx="${Math.round(fontPx * 0.3)}" fill="#E5E7EB" fill-opacity="0.95" stroke="#C4C9D1" stroke-width="1"/></svg>`,
  );
  const overlay = await sharp(box).composite([{ input: label.data, left: pad, top: pad }]).png().toBuffer();
  await img
    .composite([{ input: overlay, left: Math.max(0, W - bw - margin), top: margin }])
    .jpeg({ quality: 82 })
    .toFile(outJpg);
  return { width: W, height: H };
}
