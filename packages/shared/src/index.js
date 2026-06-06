export const IMAGE_STATUSES = Object.freeze({
  DRAFT: 'draft',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  DELETED: 'deleted',
});

export const ACCEPTED_IMAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.heic']);
export const ACCEPTED_IMAGE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/heic']);

export const VALIDATION_LIMITS = Object.freeze({
  maxUploadBytes: 12 * 1024 * 1024,
  minUploadBytes: 10 * 1024,
  minWidth: 512,
  minHeight: 512,
  maxWidth: 8000,
  maxHeight: 8000,
  blurVarianceThreshold: 1.5,
  duplicateHashDistanceThreshold: 8,
  minFaceCoverageRatio: 0.02,
  minFaceWidthRatio: 0.1,
  faceDetectionMinConfidence: 0.35,
  faceDetectionMaxPixels: 1024,
  maxFaces: 1,
});

export function getFileExtension(fileName = '') {
  const match = /\.([^.]+)$/.exec(fileName.toLowerCase());
  return match ? `.${match[1]}` : '';
}

export function isAcceptedImage(fileName, mimeType) {
  return ACCEPTED_IMAGE_EXTENSIONS.includes(getFileExtension(fileName)) && ACCEPTED_IMAGE_MIME_TYPES.includes(mimeType);
}

export function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatTimestamp(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
