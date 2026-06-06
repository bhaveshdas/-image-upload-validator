import path from 'node:path';
import { IMAGE_STATUSES } from '@upload-platform/shared';
import { analyzeImage, createNormalizedDerivatives } from './validation.js';

function extensionForMime(mimeType) {
  if (mimeType === 'image/png') return 'png';
  return 'jpg';
}

export function createWorker({ store, storage, events }) {
  let running = false;
  let interval = null;

  async function processJob(job) {
    const image = await store.getImage(job.imageId);
    if (!image || image.status === IMAGE_STATUSES.DELETED) {
      await store.finishJob(job.id, IMAGE_STATUSES.DELETED);
      return;
    }

    try {
      const originalBuffer = await storage.readBuffer(image.storageKey);
      const acceptedHashes = await store.acceptedHashes();
      const analysis = await analyzeImage(originalBuffer, {
        fileName: image.originalFileName,
        mimeType: image.contentType,
        acceptedHashes,
      });

      await store.addValidationResult(image.id, {
        status: analysis.accepted ? IMAGE_STATUSES.ACCEPTED : IMAGE_STATUSES.REJECTED,
        details: {
          blurScore: analysis.blurScore,
          mimeType: analysis.mimeType,
          extension: analysis.extension,
          face: analysis.face,
          reasons: analysis.reasons,
        },
        blurScore: analysis.blurScore,
        hash: analysis.hash,
        faceData: analysis.face,
      });

      if (!analysis.accepted) {
        await store.updateImageFromValidation(image.id, analysis);
        await store.finishJob(job.id, IMAGE_STATUSES.REJECTED);
        events.emit('image.updated', { id: image.id });
        return;
      }

      const derivatives = await createNormalizedDerivatives(analysis.normalizedBuffer, analysis.mimeType);
      const baseName = path.basename(image.fileName, path.extname(image.fileName));
      const variantExt = extensionForMime(derivatives.mimeType);
      const normalizedKey = `derived/${image.id}/${baseName}.normalized.${variantExt}`;
      const thumbnailKey = `derived/${image.id}/${baseName}.thumb.png`;
      await storage.saveBuffer(normalizedKey, derivatives.mimeType === 'image/png' ? derivatives.pngBuffer : derivatives.jpegBuffer);
      await storage.saveBuffer(thumbnailKey, derivatives.pngBuffer);
      const version = await store.addVersion(image.id, {
        kind: 'normalized',
        storageKey: normalizedKey,
        mimeType: derivatives.mimeType,
        width: derivatives.width,
        height: derivatives.height,
      });
      await store.addVersion(image.id, {
        kind: 'thumbnail',
        storageKey: thumbnailKey,
        mimeType: 'image/png',
        width: Math.max(1, Math.round((derivatives.width || 1) / 8)),
        height: Math.max(1, Math.round((derivatives.height || 1) / 8)),
      });
      await store.updateImage(image.id, {
        status: IMAGE_STATUSES.ACCEPTED,
        rejectionReasons: [],
        hash: analysis.hash,
        width: derivatives.width,
        height: derivatives.height,
        previewKey: thumbnailKey,
        normalizedKey,
      });
      await store.finishJob(job.id, IMAGE_STATUSES.ACCEPTED);
      events.emit('image.updated', { id: image.id, versionId: version.id });
    } catch (error) {
      await store.finishJob(job.id, IMAGE_STATUSES.REJECTED, error instanceof Error ? error.message : String(error));
      await store.updateImage(image.id, {
        status: IMAGE_STATUSES.REJECTED,
        rejectionReasons: [{ code: 'processing_error', message: 'The worker failed while processing the file.' }],
      });
      events.emit('image.updated', { id: image.id, error: true });
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const job = await store.claimNextJob();
        if (!job) break;
        await processJob(job);
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      interval = setInterval(() => {
        pump().catch(() => {});
      }, 500);
      void pump();
    },
    stop() {
      if (interval) clearInterval(interval);
    },
    poke() {
      return pump();
    },
  };
}
