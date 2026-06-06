import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { analyzeImage } from '../src/validation.js';

const require = createRequire(import.meta.url);
const faceApiRoot = path.dirname(require.resolve('@vladmandic/face-api/package.json'));
const sampleGroupPhoto = path.join(faceApiRoot, 'demo/sample1.jpg');

function checkerBuffer(width, height, block = 24) {
  const buffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      const bright = ((Math.floor(x / block) + Math.floor(y / block)) % 2) === 0;
      const value = bright ? 235 : 18;
      buffer[idx] = value;
      buffer[idx + 1] = value;
      buffer[idx + 2] = value;
    }
  }
  return buffer;
}

async function createCheckerPng(width = 1200, height = 1200) {
  return sharp(checkerBuffer(width, height), { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function createFlatPng(width = 1200, height = 1200) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  }).png().toBuffer();
}

async function createSingleFaceJpeg() {
  return sharp(sampleGroupPhoto)
    .extract({ left: 320, top: 250, width: 520, height: 650 })
    .resize(900, 1000)
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function createSmallFaceJpeg() {
  const smallFace = await sharp(sampleGroupPhoto)
    .extract({ left: 320, top: 250, width: 520, height: 650 })
    .resize(220, 275)
    .jpeg({ quality: 95 })
    .toBuffer();

  return sharp({
    create: {
      width: 1200,
      height: 1200,
      channels: 3,
      background: { r: 230, g: 230, b: 230 },
    },
  })
    .composite([{ input: smallFace, left: 540, top: 500 }])
    .jpeg({ quality: 95 })
    .toBuffer();
}

function reasonCodes(result) {
  return result.reasons.map((reason) => reason.code);
}

test('rejects images with too-small file size or resolution', async () => {
  const buffer = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  }).png().toBuffer();

  const result = await analyzeImage(buffer, {
    fileName: 'tiny.png',
    mimeType: 'image/png',
    acceptedHashes: [],
  });

  assert.equal(result.accepted, false);
  assert.ok(reasonCodes(result).includes('file_too_small'));
  assert.ok(reasonCodes(result).includes('resolution_too_small'));
});

test('rejects unsupported image formats', async () => {
  const buffer = await sharp(checkerBuffer(1200, 1200), { raw: { width: 1200, height: 1200, channels: 3 } }).webp().toBuffer();

  const result = await analyzeImage(buffer, {
    fileName: 'sample.webp',
    mimeType: 'image/webp',
    acceptedHashes: [],
  });

  assert.equal(result.accepted, false);
  assert.ok(reasonCodes(result).includes('unsupported_format'));
});

test('rejects images too similar to an accepted image', async () => {
  const buffer = await createSingleFaceJpeg();
  const first = await analyzeImage(buffer, {
    fileName: 'first.jpg',
    mimeType: 'image/jpeg',
    acceptedHashes: [],
  });

  const second = await analyzeImage(buffer, {
    fileName: 'second.jpg',
    mimeType: 'image/jpeg',
    acceptedHashes: [first.hash],
  });

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.ok(reasonCodes(second).includes('duplicate_image'));
});

test('rejects blurry images', async () => {
  const buffer = await createFlatPng();
  const result = await analyzeImage(buffer, {
    fileName: 'flat.png',
    mimeType: 'image/png',
    acceptedHashes: [],
  });

  assert.equal(result.accepted, false);
  assert.ok(reasonCodes(result).includes('too_blurry'));
});

test('rejects images with no detected face', async () => {
  const buffer = await createCheckerPng();
  const result = await analyzeImage(buffer, {
    fileName: 'no-face.png',
    mimeType: 'image/png',
    acceptedHashes: [],
  });

  assert.equal(result.accepted, false);
  assert.ok(reasonCodes(result).includes('no_face_detected'));
  assert.equal(result.face.count, 0);
});

test('rejects images where the detected face is too small', async () => {
  const buffer = await createSmallFaceJpeg();
  const result = await analyzeImage(buffer, {
    fileName: 'small-face.jpg',
    mimeType: 'image/jpeg',
    acceptedHashes: [],
  });

  assert.equal(result.accepted, false);
  assert.ok(reasonCodes(result).includes('face_too_small'));
  assert.equal(result.face.count, 1);
});

test('rejects images containing multiple faces', async () => {
  const buffer = await sharp(sampleGroupPhoto).jpeg({ quality: 95 }).toBuffer();
  const result = await analyzeImage(buffer, {
    fileName: 'group.jpg',
    mimeType: 'image/jpeg',
    acceptedHashes: [],
  });

  assert.equal(result.accepted, false);
  assert.ok(reasonCodes(result).includes('multiple_faces'));
  assert.ok(result.face.count > 1);
});

test('accepts a valid JPG image when no rejection rules match', async () => {
  const buffer = await createSingleFaceJpeg();
  const result = await analyzeImage(buffer, {
    fileName: 'selfie.jpg',
    mimeType: 'image/jpeg',
    acceptedHashes: [],
  });

  assert.equal(result.accepted, true);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.face.count, 1);
});
