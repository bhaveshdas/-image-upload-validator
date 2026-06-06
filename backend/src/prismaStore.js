import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { IMAGE_STATUSES } from '@upload-platform/shared';

function now() {
  return new Date();
}

function normalizeImage(image) {
  if (!image) return null;
  return {
    ...image,
    rejectionReasons: image.rejectionReasons || [],
  };
}

export class PrismaStore {
  constructor(prisma = new PrismaClient()) {
    this.prisma = prisma;
    this.ready = Promise.resolve();
  }

  async listImages() {
    const images = await this.prisma.image.findMany({
      where: { status: { not: IMAGE_STATUSES.DELETED } },
      orderBy: { createdAt: 'desc' },
    });
    return images.map(normalizeImage);
  }

  async getImage(id) {
    return normalizeImage(await this.prisma.image.findUnique({ where: { id } }));
  }

  async getImageByToken(token) {
    return this.prisma.uploadToken.findFirst({
      where: {
        token,
        expiresAt: { gt: now() },
      },
    });
  }

  async getMediaByToken(token) {
    return this.prisma.mediaToken.findFirst({
      where: {
        token,
        expiresAt: { gt: now() },
      },
    });
  }

  async createImage({ fileName, originalFileName, contentType, sizeBytes }) {
    return normalizeImage(await this.prisma.image.create({
      data: {
        id: crypto.randomUUID(),
        fileName,
        originalFileName,
        contentType,
        sizeBytes,
        status: IMAGE_STATUSES.DRAFT,
        rejectionReasons: [],
      },
    }));
  }

  async updateImage(id, updates) {
    const data = { ...updates };
    if (data.createdAt) data.createdAt = new Date(data.createdAt);
    if (data.updatedAt) data.updatedAt = new Date(data.updatedAt);
    if (data.deletedAt) data.deletedAt = new Date(data.deletedAt);
    try {
      return normalizeImage(await this.prisma.image.update({
        where: { id },
        data,
      }));
    } catch (error) {
      if (error?.code === 'P2025') return null;
      throw error;
    }
  }

  async softDeleteImage(id) {
    return this.updateImage(id, {
      status: IMAGE_STATUSES.DELETED,
      deletedAt: now(),
    });
  }

  async attachUploadToken(imageId, token, expiresAt) {
    const expires = new Date(expiresAt);
    const record = await this.prisma.uploadToken.create({
      data: { token, imageId, expiresAt: expires },
    });
    await this.updateImage(imageId, {
      status: IMAGE_STATUSES.UPLOADING,
      uploadToken: token,
      uploadTokenExpiresAt: expires,
    });
    return record;
  }

  async consumeUploadToken(token) {
    const entry = await this.prisma.uploadToken.findUnique({ where: { token } });
    if (!entry) return null;
    await this.prisma.uploadToken.delete({ where: { token } });
    return entry;
  }

  async setUploaded(imageId, { storageKey, sizeBytes, contentType }) {
    return this.updateImage(imageId, {
      storageKey,
      sizeBytes,
      contentType,
      status: IMAGE_STATUSES.UPLOADED,
    });
  }

  async enqueueJob(imageId) {
    const existing = await this.prisma.processingJob.findFirst({
      where: {
        imageId,
        state: { in: [IMAGE_STATUSES.QUEUED, IMAGE_STATUSES.PROCESSING] },
      },
    });
    if (existing) return existing;

    const job = await this.prisma.processingJob.create({
      data: {
        id: crypto.randomUUID(),
        imageId,
        state: IMAGE_STATUSES.QUEUED,
      },
    });
    await this.updateImage(imageId, { status: IMAGE_STATUSES.QUEUED });
    return job;
  }

  async recoverInterruptedJobs() {
    const jobs = await this.prisma.processingJob.findMany({
      where: { state: IMAGE_STATUSES.PROCESSING },
    });
    for (const job of jobs) {
      await this.prisma.processingJob.update({
        where: { id: job.id },
        data: {
          state: IMAGE_STATUSES.QUEUED,
          lockedAt: null,
        },
      });
      await this.prisma.image.updateMany({
        where: {
          id: job.imageId,
          status: IMAGE_STATUSES.PROCESSING,
        },
        data: { status: IMAGE_STATUSES.QUEUED },
      });
    }
  }

  async claimNextJob() {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.processingJob.findFirst({
        where: {
          state: IMAGE_STATUSES.QUEUED,
          availableAt: { lte: now() },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!job) return null;

      const locked = await tx.processingJob.updateMany({
        where: {
          id: job.id,
          state: IMAGE_STATUSES.QUEUED,
        },
        data: {
          state: IMAGE_STATUSES.PROCESSING,
          lockedAt: now(),
          attempts: { increment: 1 },
        },
      });
      if (locked.count === 0) return null;

      await tx.image.update({
        where: { id: job.imageId },
        data: { status: IMAGE_STATUSES.PROCESSING },
      });

      return tx.processingJob.findUnique({ where: { id: job.id } });
    });
  }

  async finishJob(jobId, state, error = null) {
    try {
      return await this.prisma.processingJob.update({
        where: { id: jobId },
        data: {
          state,
          lastError: error,
        },
      });
    } catch (updateError) {
      if (updateError?.code === 'P2025') return null;
      throw updateError;
    }
  }

  async addVersion(imageId, version) {
    const record = await this.prisma.imageVersion.create({
      data: {
        id: crypto.randomUUID(),
        imageId,
        ...version,
      },
    });
    await this.updateImage(imageId, { latestVersionId: record.id });
    return record;
  }

  async addValidationResult(imageId, result) {
    return this.prisma.validationResult.create({
      data: {
        id: crypto.randomUUID(),
        imageId,
        ...result,
      },
    });
  }

  async listVersionsForImage(imageId) {
    return this.prisma.imageVersion.findMany({
      where: { imageId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listValidationResultsForImage(imageId) {
    return this.prisma.validationResult.findMany({
      where: { imageId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async acceptedHashes() {
    const images = await this.prisma.image.findMany({
      where: {
        status: IMAGE_STATUSES.ACCEPTED,
        hash: { not: null },
      },
      select: { hash: true },
    });
    return images.map((image) => image.hash).filter(Boolean);
  }

  async updateImageFromValidation(imageId, outcome) {
    return this.updateImage(imageId, {
      status: outcome.accepted ? IMAGE_STATUSES.ACCEPTED : IMAGE_STATUSES.REJECTED,
      rejectionReasons: outcome.reasons,
      hash: outcome.hash,
      width: outcome.width,
      height: outcome.height,
    });
  }

  async attachMediaToken(imageId, key, expiresAt) {
    const token = crypto.randomUUID();
    await this.prisma.mediaToken.create({
      data: {
        token,
        imageId,
        key,
        expiresAt: new Date(expiresAt),
      },
    });
    return token;
  }
}
