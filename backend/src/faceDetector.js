import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { VALIDATION_LIMITS } from '@upload-platform/shared';

const require = createRequire(import.meta.url);
const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-backend-wasm');
const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');

const faceApiRoot = path.resolve(path.dirname(require.resolve('@vladmandic/face-api/package.json')));
const modelPath = path.join(faceApiRoot, 'model');
let modelReady;

async function ensureModel() {
  if (!modelReady) {
    modelReady = (async () => {
      await tf.setBackend('wasm');
      await tf.ready();
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
    })();
  }
  return modelReady;
}

function toPlainBox(box) {
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  };
}

export async function detectFaces(buffer) {
  await ensureModel();

  const image = sharp(buffer)
    .rotate()
    .resize({
      width: VALIDATION_LIMITS.faceDetectionMaxPixels,
      height: VALIDATION_LIMITS.faceDetectionMaxPixels,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .removeAlpha();

  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, info.channels], 'int32');

  try {
    const options = new faceapi.SsdMobilenetv1Options({
      minConfidence: VALIDATION_LIMITS.faceDetectionMinConfidence,
      maxResults: 10,
    });
    const detections = await faceapi.detectAllFaces(tensor, options);
    const faces = detections.map((detection) => {
      const box = toPlainBox(detection.box);
      return {
        score: detection.score,
        coverageRatio: (box.width * box.height) / (info.width * info.height),
        widthRatio: box.width / info.width,
        heightRatio: box.height / info.height,
        bbox: box,
      };
    });

    faces.sort((left, right) => right.score - left.score);

    return {
      detected: faces.length > 0,
      count: faces.length,
      faces,
      coverageRatio: faces[0]?.coverageRatio || 0,
      widthRatio: faces[0]?.widthRatio || 0,
      bbox: faces[0]?.bbox || null,
      detector: 'ssd_mobilenetv1',
      minConfidence: VALIDATION_LIMITS.faceDetectionMinConfidence,
    };
  } finally {
    tf.dispose(tensor);
  }
}
