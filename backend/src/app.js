import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { IMAGE_STATUSES, VALIDATION_LIMITS, humanFileSize, isAcceptedImage } from '@upload-platform/shared';
import { EventHub } from './events.js';
import { FileStore } from './store.js';
import { PrismaStore } from './prismaStore.js';
import { LocalStorage, MinioStorage } from './storage.js';
import { createWorker } from './worker.js';
import { getConfig } from './config.js';

function createSignedTokenPayload({ token, kind, id, key, expiresAt }) {
  return { token, kind, id, key, expiresAt };
}

function signUploadUrl(baseUrl, token) {
  return `${baseUrl}/api/uploads/${token}`;
}

function signMediaUrl(baseUrl, token) {
  return `${baseUrl}/api/media/${token}`;
}

function createBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function createUploadTicketLimiter({ limit, windowMs = 60 * 60 * 1000 }) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.status(429).json({ error: 'Too many upload attempts. Try again later.' });
      return;
    }
    next();
  };
}

async function ensureDirectories(dataDir, storageDir) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(storageDir, { recursive: true });
}

async function bufferFromRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function serveMediaToken(store, storage, res, token) {
  const entry = await store.getMediaByToken(token);
  if (!entry) {
    res.status(404).json({ error: 'Token expired or not found' });
    return;
  }
  const fileName = path.basename(entry.key);
  res.setHeader('Content-Type', fileName.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  await storage.writeToResponse(entry.key, res);
}

function createStore(config) {
  if (config.storeDriver === 'prisma') return new PrismaStore();
  return new FileStore(config.dataDir);
}

function createStorage(config) {
  if (config.storageDriver === 'minio') return new MinioStorage(config.minio);
  return new LocalStorage(config.storageDir);
}

export async function createPlatform() {
  const config = getConfig();
  if (config.storeDriver !== 'prisma' || config.storageDriver !== 'minio') {
    await ensureDirectories(config.dataDir, config.storageDir);
  }
  const app = express();
  const store = createStore(config);
  const storage = createStorage(config);
  const events = new EventHub();
  const worker = createWorker({ store, storage, events });

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  const limitUploadTickets = createUploadTicketLimiter({ limit: config.maxUploadTicketsPerHour });

  app.get('/api/health', async (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/events', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('event: ready\ndata: {}\n\n');
    events.add(res);
    req.on('close', () => res.end());
  });

  app.post('/api/images', limitUploadTickets, async (req, res) => {
    const { fileName, contentType, sizeBytes } = req.body || {};
    if (!fileName || !contentType || !Number.isFinite(sizeBytes)) {
      res.status(400).json({ error: 'fileName, contentType, and sizeBytes are required.' });
      return;
    }
    if (!isAcceptedImage(fileName, contentType)) {
      res.status(400).json({ error: 'Unsupported image type.' });
      return;
    }
    if (sizeBytes < VALIDATION_LIMITS.minUploadBytes) {
      res.status(400).json({ error: 'Image is too small to upload.' });
      return;
    }
    if (sizeBytes > VALIDATION_LIMITS.maxUploadBytes) {
      res.status(400).json({ error: 'Image exceeds the upload limit.' });
      return;
    }

    const baseUrl = createBaseUrl(req);
    const image = await store.createImage({
      fileName,
      originalFileName: fileName,
      contentType,
      sizeBytes,
    });
    const uploadToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + config.uploadTokenTtlMs).toISOString();
    await store.attachUploadToken(image.id, uploadToken, expiresAt);
    res.status(201).json({
      image: await getImageWithUrls(store, baseUrl, image.id, config.mediaTokenTtlMs),
      uploadUrl: signUploadUrl(baseUrl, uploadToken),
      expiresAt,
    });
  });

  app.put('/api/uploads/:token', express.raw({ type: '*/*', limit: '15mb' }), async (req, res) => {
    const token = req.params.token;
    const upload = await store.getImageByToken(token);
    if (!upload) {
      res.status(404).json({ error: 'Upload token expired or not found.' });
      return;
    }
    const image = await store.getImage(upload.imageId);
    if (!image) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }
    const buffer = Buffer.isBuffer(req.body) ? req.body : await bufferFromRequest(req);
    const storageKey = `originals/${image.id}/${path.basename(image.originalFileName)}`;
    await storage.saveBuffer(storageKey, buffer, image.contentType);
    await store.setUploaded(image.id, {
      storageKey,
      sizeBytes: buffer.byteLength,
      contentType: image.contentType,
    });
    await store.consumeUploadToken(token);
    await store.enqueueJob(image.id);
    events.emit('image.updated', { id: image.id });
    res.status(204).end();
  });

  app.get('/api/images', async (req, res) => {
    const images = await store.listImages();
    const baseUrl = createBaseUrl(req);
    const decorated = await Promise.all(images.map((image) => getImageWithUrls(store, baseUrl, image.id, config.mediaTokenTtlMs)));
    res.json({ images: decorated });
  });

  app.get('/api/images/:id', async (req, res) => {
    const baseUrl = createBaseUrl(req);
    const image = await getImageWithUrls(store, baseUrl, req.params.id, config.mediaTokenTtlMs);
    if (!image) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }
    res.json({ image });
  });

  app.post('/api/images/:id/retry', async (req, res) => {
    const image = await store.getImage(req.params.id);
    if (!image || image.status === IMAGE_STATUSES.DELETED) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }
    await store.updateImage(req.params.id, {
      status: IMAGE_STATUSES.QUEUED,
      rejectionReasons: [],
    });
    await store.enqueueJob(req.params.id);
    worker.poke().catch(() => {});
    events.emit('image.updated', { id: req.params.id });
    res.json({ ok: true });
  });

  app.delete('/api/images/:id', async (req, res) => {
    const image = await store.softDeleteImage(req.params.id);
    if (!image) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }
    events.emit('image.updated', { id: req.params.id, deleted: true });
    res.json({ ok: true });
  });

  app.get('/api/media/:token', async (req, res) => {
    await serveMediaToken(store, storage, res, req.params.token);
  });

  app.use((error, _req, res, _next) => {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected server error',
    });
  });

  await store.recoverInterruptedJobs();
  worker.start();

  return { app, store, storage, events, worker };
}

async function getImageWithUrls(store, baseUrl, imageId, mediaTokenTtlMs) {
  const image = await store.getImage(imageId);
  if (!image) return null;
  const versions = await store.listVersionsForImage(imageId);
  const validationResults = await store.listValidationResultsForImage(imageId);
  const mediaUrls = {};

  if (image.previewKey) {
    const token = await store.attachMediaToken(imageId, image.previewKey, new Date(Date.now() + mediaTokenTtlMs).toISOString());
    mediaUrls.preview = signMediaUrl(baseUrl, token);
  }

  if (image.storageKey) {
    const token = await store.attachMediaToken(imageId, image.storageKey, new Date(Date.now() + mediaTokenTtlMs).toISOString());
    mediaUrls.original = signMediaUrl(baseUrl, token);
  }

  for (const version of versions) {
    const token = await store.attachMediaToken(imageId, version.storageKey, new Date(Date.now() + mediaTokenTtlMs).toISOString());
    mediaUrls[version.kind] = signMediaUrl(baseUrl, token);
  }

  return {
    ...image,
    sizeLabel: humanFileSize(image.sizeBytes),
    mediaUrls,
    versions,
    validationResults,
  };
}
