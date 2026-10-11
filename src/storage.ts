import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const root = path.resolve(config.dataDir);

export const tmpDir = path.join(root, 'tmp');
export const linkDir = (linkId: string): string => path.join(root, 'docs', linkId);
export const versionDir = (linkId: string, versionNo: number): string => path.join(linkDir(linkId), `v${versionNo}`);
export const originalPath = (linkId: string, versionNo: number): string => path.join(versionDir(linkId, versionNo), 'original.pdf');
export const pagePath = (linkId: string, versionNo: number, pageNo: number): string =>
  path.join(versionDir(linkId, versionNo), 'pages', `${pageNo}.jpg`);
export const ogPath = (linkId: string, versionNo: number): string => path.join(versionDir(linkId, versionNo), 'og.jpg');

export async function ensureStorage(): Promise<void> {
  await mkdir(tmpDir, { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
