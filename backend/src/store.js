import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { IMAGE_STATUSES } from '@upload-platform/shared';

function nowIso() {
  return new Date().toISOString();
}

function createEmptyState() {
  return {
    images: [],
    versions: [],
    validationResults: [],
    jobs: [],
    uploadTokens: [],
    mediaTokens: [],
  };
}

export class FileStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, 'store.json');
    this.state = createEmptyState();
    this.ready = this.load();
  }

  async load() {
    await fs.mkdir(this.baseDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = { ...createEmptyState(), ...JSON.parse(raw) };
    } catch {
      this.state = createEmptyState();
      await this.persist();
    }
  }

  async persist() {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  async snapshot() {
    await this.ready;
    return this.state;
  }

  async listImages() {
    await this.ready;
    return [...this.state.images]
      .filter((image) => image.status !== IMAGE_STATUSES.DELETED)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async getImage(id) {
    await this.ready;
    return this.state.images.find((image) => image.id === id) || null;
  }

  async getImageByToken(token) {
    await this.ready;
    return this.state.uploadTokens.find((entry) => entry.token === token && new Date(entry.expiresAt) > new Date()) || null;
  }

  async getMediaByToken(token) {
    await this.ready;
    return this.state.mediaTokens.find((entry) => entry.token === token && new Date(entry.expiresAt) > new Date()) || null;
  }

  async createImage({ fileName, originalFileName, contentType, sizeBytes }) {
    await this.ready;
    const id = crypto.randomUUID();
    const record = {
      id,
      fileName,
      originalFileName,
      contentType,
      sizeBytes,
      status: IMAGE_STATUSES.DRAFT,
      rejectionReasons: [],
      storageKey: null,
      previewKey: null,
      hash: null,
      width: null,
      height: null,
      deletedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      latestVersionId: null,
      uploadToken: null,
      uploadTokenExpiresAt: null,
    };
    this.state.images.push(record);
    await this.persist();
    return record;
  }

  async updateImage(id, updates) {
    await this.ready;
    const image = this.state.images.find((entry) => entry.id === id);
    if (!image) return null;
    Object.assign(image, updates, { updatedAt: nowIso() });
    await this.persist();
    return image;
  }

  async softDeleteImage(id) {
    return this.updateImage(id, {
      status: IMAGE_STATUSES.DELETED,
      deletedAt: nowIso(),
    });
  }

  async attachUploadToken(imageId, token, expiresAt) {
    await this.ready;
    const image = this.state.images.find((entry) => entry.id === imageId);
    if (!image) return null;
    const record = { token, imageId, expiresAt };
    this.state.uploadTokens.push(record);
    image.uploadToken = token;
    image.uploadTokenExpiresAt = expiresAt;
    image.status = IMAGE_STATUSES.UPLOADING;
    image.updatedAt = nowIso();
    await this.persist();
    return record;
  }

  async consumeUploadToken(token) {
    await this.ready;
    const index = this.state.uploadTokens.findIndex((entry) => entry.token === token);
    if (index === -1) return null;
    const entry = this.state.uploadTokens[index];
    this.state.uploadTokens.splice(index, 1);
    await this.persist();
    return entry;
  }

  async setUploaded(imageId, { storageKey, sizeBytes, contentType }) {
    const image = await this.updateImage(imageId, {
      storageKey,
      sizeBytes,
      contentType,
      status: IMAGE_STATUSES.UPLOADED,
    });
    return image;
  }

  async enqueueJob(imageId) {
    await this.ready;
    const existing = this.state.jobs.find((job) => job.imageId === imageId && ['queued', 'processing'].includes(job.state));
    if (existing) return existing;
    const job = {
      id: crypto.randomUUID(),
      imageId,
      state: IMAGE_STATUSES.QUEUED,
      attempts: 0,
      availableAt: nowIso(),
      lockedAt: null,
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.state.jobs.push(job);
    await this.updateImage(imageId, { status: IMAGE_STATUSES.QUEUED });
    await this.persist();
    return job;
  }

  async recoverInterruptedJobs() {
    await this.ready;
    let changed = false;
    for (const job of this.state.jobs) {
      if (job.state === IMAGE_STATUSES.PROCESSING) {
        job.state = IMAGE_STATUSES.QUEUED;
        job.lockedAt = null;
        job.updatedAt = nowIso();
        const image = this.state.images.find((entry) => entry.id === job.imageId);
        if (image && image.status === IMAGE_STATUSES.PROCESSING) {
          image.status = IMAGE_STATUSES.QUEUED;
          image.updatedAt = nowIso();
        }
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async claimNextJob() {
    await this.ready;
    const available = this.state.jobs.find((job) => job.state === IMAGE_STATUSES.QUEUED && new Date(job.availableAt) <= new Date());
    if (!available) return null;
    available.state = IMAGE_STATUSES.PROCESSING;
    available.lockedAt = nowIso();
    available.attempts += 1;
    available.updatedAt = nowIso();
    await this.updateImage(available.imageId, { status: IMAGE_STATUSES.PROCESSING });
    await this.persist();
    return available;
  }

  async finishJob(jobId, state, error = null) {
    await this.ready;
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    if (!job) return null;
    job.state = state;
    job.updatedAt = nowIso();
    job.lastError = error;
    await this.persist();
    return job;
  }

  async addVersion(imageId, version) {
    await this.ready;
    const record = {
      id: crypto.randomUUID(),
      imageId,
      createdAt: nowIso(),
      ...version,
    };
    this.state.versions.push(record);
    const image = this.state.images.find((entry) => entry.id === imageId);
    if (image) {
      image.latestVersionId = record.id;
      image.updatedAt = nowIso();
    }
    await this.persist();
    return record;
  }

  async addValidationResult(imageId, result) {
    await this.ready;
    const record = {
      id: crypto.randomUUID(),
      imageId,
      createdAt: nowIso(),
      ...result,
    };
    this.state.validationResults.push(record);
    await this.persist();
    return record;
  }

  async listVersionsForImage(imageId) {
    await this.ready;
    return this.state.versions.filter((version) => version.imageId === imageId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  async listValidationResultsForImage(imageId) {
    await this.ready;
    return this.state.validationResults.filter((result) => result.imageId === imageId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async acceptedHashes() {
    await this.ready;
    return this.state.images
      .filter((image) => image.status === IMAGE_STATUSES.ACCEPTED && image.hash)
      .map((image) => image.hash);
  }

  async updateImageFromValidation(imageId, outcome) {
    const image = await this.updateImage(imageId, {
      status: outcome.accepted ? IMAGE_STATUSES.ACCEPTED : IMAGE_STATUSES.REJECTED,
      rejectionReasons: outcome.reasons,
      hash: outcome.hash,
      width: outcome.width,
      height: outcome.height,
    });
    return image;
  }

  async attachMediaToken(imageId, key, expiresAt) {
    await this.ready;
    const token = crypto.randomUUID();
    this.state.mediaTokens.push({ token, imageId, key, expiresAt });
    await this.persist();
    return token;
  }
}
