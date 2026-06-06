import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getConfig() {
  return {
    rootDir,
    storeDriver: process.env.STORE_DRIVER || (process.env.DATABASE_URL ? 'prisma' : 'file'),
    storageDriver: process.env.STORAGE_DRIVER || (process.env.MINIO_ENDPOINT ? 'minio' : 'local'),
    dataDir: process.env.PLATFORM_DATA_DIR || path.join(rootDir, 'data'),
    storageDir: process.env.PLATFORM_STORAGE_DIR || path.join(rootDir, 'data', 'storage'),
    port: Number(process.env.PORT || 4000),
    uploadTokenTtlMs: Number(process.env.UPLOAD_TOKEN_TTL_MS || 10 * 60 * 1000),
    mediaTokenTtlMs: Number(process.env.MEDIA_TOKEN_TTL_MS || 30 * 60 * 1000),
    maxUploadTicketsPerHour: Number(process.env.MAX_UPLOAD_TICKETS_PER_HOUR || 60),
    minio: {
      endpoint: process.env.MINIO_ENDPOINT || 'http://127.0.0.1:9000',
      region: process.env.MINIO_REGION || 'us-east-1',
      bucket: process.env.MINIO_BUCKET || 'image-uploads',
      accessKeyId: process.env.MINIO_ACCESS_KEY_ID || 'minioadmin',
      secretAccessKey: process.env.MINIO_SECRET_ACCESS_KEY || 'minioadmin',
      forcePathStyle: process.env.MINIO_FORCE_PATH_STYLE !== 'false',
    },
  };
}
