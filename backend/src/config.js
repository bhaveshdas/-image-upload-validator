import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getConfig() {
  return {
    rootDir,
    dataDir: process.env.PLATFORM_DATA_DIR || path.join(rootDir, 'data'),
    storageDir: process.env.PLATFORM_STORAGE_DIR || path.join(rootDir, 'data', 'storage'),
    port: Number(process.env.PORT || 4000),
    uploadTokenTtlMs: Number(process.env.UPLOAD_TOKEN_TTL_MS || 10 * 60 * 1000),
    mediaTokenTtlMs: Number(process.env.MEDIA_TOKEN_TTL_MS || 30 * 60 * 1000),
  };
}
