import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const root = path.resolve(config.dataDir);

/** "desktop" is also the default file shown on every device when a version has no mobile file. */
export type Variant = 'desktop' | 'mobile';
export const VARIANTS: readonly Variant[] = ['desktop', 'mobile'];

export const tmpDir = path.join(root, 'tmp');
export const brandDir = path.join(root, 'brand');
export const linkDir = (linkId: string): string => path.join(root, 'docs', linkId);
export const versionDir = (linkId: string, versionNo: number): string => path.join(linkDir(linkId), `v${versionNo}`);
/** The desktop variant lives in the version directory itself (as before); mobile in a sub-directory. */
export const variantDir = (linkId: string, versionNo: number, variant: Variant): string =>
  variant === 'mobile' ? path.join(versionDir(linkId, versionNo), 'mobile') : versionDir(linkId, versionNo);
export const originalPath = (linkId: string, versionNo: number, variant: Variant = 'desktop'): string =>
  path.join(variantDir(linkId, versionNo, variant), 'original.pdf');
export const pagePath = (linkId: string, versionNo: number, pageNo: number, variant: Variant = 'desktop'): string =>
  path.join(variantDir(linkId, versionNo, variant), 'pages', `${pageNo}.jpg`);
export const ogPath = (linkId: string, versionNo: number): string => path.join(versionDir(linkId, versionNo), 'og.jpg');

export async function ensureStorage(): Promise<void> {
  await mkdir(tmpDir, { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
