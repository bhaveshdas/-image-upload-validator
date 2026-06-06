import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { createPlatform } from '../src/app.js';

const require = createRequire(import.meta.url);
const faceApiRoot = path.dirname(require.resolve('@vladmandic/face-api/package.json'));

async function createSampleImage() {
  return sharp(path.join(faceApiRoot, 'demo/sample1.jpg'))
    .extract({ left: 320, top: 250, width: 520, height: 650 })
    .resize(900, 1000)
    .jpeg({ quality: 95 })
    .toBuffer();
}

test('upload orchestration completes and returns an accepted image', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-'));
  process.env.PLATFORM_DATA_DIR = path.join(tmpDir, 'data');
  process.env.PLATFORM_STORAGE_DIR = path.join(tmpDir, 'storage');
  const { store, storage, worker } = await createPlatform();
  t.after(() => {
    worker.stop();
  });

  const buffer = await createSampleImage();
  const created = await store.createImage({
    fileName: 'valid.jpg',
    originalFileName: 'valid.jpg',
    contentType: 'image/jpeg',
    sizeBytes: buffer.byteLength,
  });

  const uploadToken = 'test-upload-token';
  await store.attachUploadToken(created.id, uploadToken, new Date(Date.now() + 60000).toISOString());
  await storage.saveBuffer(`originals/${created.id}/valid.jpg`, buffer);
  await store.setUploaded(created.id, {
    storageKey: `originals/${created.id}/valid.jpg`,
    sizeBytes: buffer.byteLength,
    contentType: 'image/jpeg',
  });
  await store.consumeUploadToken(uploadToken);
  await store.enqueueJob(created.id);
  await worker.poke();

  await waitFor(async () => {
    const latest = await store.getImage(created.id);
    return latest?.status === 'accepted' ? latest : null;
  });

  const latest = await store.getImage(created.id);
  assert.equal(latest.status, 'accepted');
  assert.ok(latest.previewKey);
  const versions = await store.listVersionsForImage(created.id);
  assert.ok(versions.length >= 2);
  const validations = await store.listValidationResultsForImage(created.id);
  assert.ok(validations.length >= 1);
});

async function waitFor(fn, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
