import crypto from 'node:crypto';
import sharp from 'sharp';
import { ACCEPTED_IMAGE_MIME_TYPES, VALIDATION_LIMITS, getFileExtension, isAcceptedImage } from '@upload-platform/shared';
import { fileTypeFromBuffer } from 'file-type';
import { detectFaces } from './faceDetector.js';

function binaryToHex(binary) {
  const chunks = binary.match(/.{1,4}/g) || [];
  return chunks.map((chunk) => Number.parseInt(chunk, 2).toString(16)).join('');
}

function hammingDistance(a, b) {
  let distance = 0;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) distance += 1;
  }
  return distance;
}

async function loadMatrix(buffer, size = 32) {
  const image = sharp(buffer).rotate().resize(size, size, { fit: 'fill' }).grayscale();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const matrix = [];
  for (let y = 0; y < info.height; y += 1) {
    const row = [];
    for (let x = 0; x < info.width; x += 1) {
      row.push(data[y * info.width + x]);
    }
    matrix.push(row);
  }
  return matrix;
}

function dct2(matrix) {
  const n = matrix.length;
  const result = Array.from({ length: n }, () => Array(n).fill(0));
  const factor = Math.PI / (2 * n);
  const scale = (k) => (k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n));

  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      let sum = 0;
      for (let x = 0; x < n; x += 1) {
        for (let y = 0; y < n; y += 1) {
          sum += matrix[y][x] * Math.cos((2 * x + 1) * u * factor) * Math.cos((2 * y + 1) * v * factor);
        }
      }
      result[u][v] = scale(u) * scale(v) * sum;
    }
  }
  return result;
}

function computePHash(matrix) {
  const transformed = dct2(matrix);
  const subset = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (x !== 0 || y !== 0) subset.push(transformed[y][x]);
    }
  }
  const sorted = [...subset].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const bits = subset.map((value) => (value > median ? '1' : '0')).join('');
  return binaryToHex(bits);
}

function computeBlurVariance(matrix) {
  const height = matrix.length;
  const width = matrix[0].length;
  const laplacian = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const value = (
        4 * matrix[y][x]
        - matrix[y - 1][x]
        - matrix[y + 1][x]
        - matrix[y][x - 1]
        - matrix[y][x + 1]
      );
      laplacian.push(value);
    }
  }
  const mean = laplacian.reduce((sum, value) => sum + value, 0) / laplacian.length;
  return laplacian.reduce((sum, value) => sum + (value - mean) ** 2, 0) / laplacian.length;
}

function normalizeMime(mimeType, fileName, detectedMimeType) {
  const extension = getFileExtension(fileName);
  const preferred = detectedMimeType || mimeType;
  if (preferred && ACCEPTED_IMAGE_MIME_TYPES.includes(preferred)) return preferred;
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.heic') return 'image/heic';
  return preferred || mimeType || 'application/octet-stream';
}

export async function analyzeImage(buffer, { fileName, mimeType, acceptedHashes = [] }) {
  const detected = await fileTypeFromBuffer(buffer);
  const metadata = await sharp(buffer).metadata();
  const actualMimeType = normalizeMime(mimeType, fileName, detected?.mime);
  const actualExtension = detected?.ext ? `.${detected.ext}` : getFileExtension(fileName);
  const isSupported = isAcceptedImage(fileName, actualMimeType) || ACCEPTED_IMAGE_MIME_TYPES.includes(actualMimeType);
  const reasons = [];

  if (!isSupported) {
    reasons.push({
      code: 'unsupported_format',
      message: 'Only JPG, PNG, and HEIC files are accepted.',
    });
  }

  if (buffer.byteLength < VALIDATION_LIMITS.minUploadBytes) {
    reasons.push({
      code: 'file_too_small',
      message: `File must be at least ${Math.round(VALIDATION_LIMITS.minUploadBytes / 1024)} KB.`,
    });
  }

  if (buffer.byteLength > VALIDATION_LIMITS.maxUploadBytes) {
    reasons.push({
      code: 'file_too_large',
      message: `File exceeds ${Math.round(VALIDATION_LIMITS.maxUploadBytes / 1024 / 1024)} MB.`,
    });
  }

  if (!metadata.width || !metadata.height) {
    reasons.push({
      code: 'unreadable_image',
      message: 'The file could not be decoded as a supported image.',
    });
  } else {
    if (metadata.width < VALIDATION_LIMITS.minWidth || metadata.height < VALIDATION_LIMITS.minHeight) {
      reasons.push({
        code: 'resolution_too_small',
        message: `Minimum resolution is ${VALIDATION_LIMITS.minWidth}x${VALIDATION_LIMITS.minHeight}.`,
      });
    }

    if (metadata.width > VALIDATION_LIMITS.maxWidth || metadata.height > VALIDATION_LIMITS.maxHeight) {
      reasons.push({
        code: 'resolution_too_large',
        message: `Maximum resolution is ${VALIDATION_LIMITS.maxWidth}x${VALIDATION_LIMITS.maxHeight}.`,
      });
    }
  }

  const normalizedBuffer = actualMimeType === 'image/heic'
    ? await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer()
    : buffer;

  const matrix = await loadMatrix(normalizedBuffer, 32);
  const blurScore = computeBlurVariance(matrix);
  if (blurScore < VALIDATION_LIMITS.blurVarianceThreshold) {
    reasons.push({
      code: 'too_blurry',
      message: 'The upload is too blurry to pass validation.',
    });
  }

  const perceptualHash = computePHash(matrix);
  const duplicate = acceptedHashes.find((hash) => hammingDistance(hash, perceptualHash) <= VALIDATION_LIMITS.duplicateHashDistanceThreshold);
  if (duplicate) {
    reasons.push({
      code: 'duplicate_image',
      message: 'This image is too similar to a previously accepted image.',
    });
  }

  const face = await detectFaces(normalizedBuffer);
  const primaryFace = face.faces[0] || null;

  if (face.count === 0) {
    reasons.push({
      code: 'no_face_detected',
      message: 'Exactly one face must be visible in the image.',
    });
  }

  if (face.count > VALIDATION_LIMITS.maxFaces) {
    reasons.push({
      code: 'multiple_faces',
      message: 'Only one face is allowed in the image.',
    });
  }

  if (
    face.count === 1
    && primaryFace
    && (
      primaryFace.coverageRatio < VALIDATION_LIMITS.minFaceCoverageRatio
      || primaryFace.widthRatio < VALIDATION_LIMITS.minFaceWidthRatio
    )
  ) {
    reasons.push({
      code: 'face_too_small',
      message: 'Detected face is too small in the frame.',
    });
  }

  return {
    fileName,
    extension: actualExtension,
    mimeType: actualMimeType,
    width: metadata.width || null,
    height: metadata.height || null,
    blurScore,
    hash: perceptualHash,
    face: {
      ...face,
      minCoverageRatio: VALIDATION_LIMITS.minFaceCoverageRatio,
      minWidthRatio: VALIDATION_LIMITS.minFaceWidthRatio,
    },
    accepted: reasons.length === 0,
    reasons,
    normalizedBuffer,
  };
}

export async function createNormalizedDerivatives(buffer, mimeType) {
  const image = sharp(buffer).rotate();
  const jpegBuffer = await image.clone().jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  const pngBuffer = await image.clone().png({ compressionLevel: 9 }).toBuffer();
  const meta = await image.metadata();
  return {
    jpegBuffer,
    pngBuffer,
    width: meta.width || null,
    height: meta.height || null,
    mimeType: mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
  };
}

export function distanceBetweenHashes(left, right) {
  return hammingDistance(left, right);
}

export function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
