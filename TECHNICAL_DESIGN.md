# Image Upload Validation Platform - Technical Design

## Purpose

This project implements an image intake and validation workflow for user-uploaded photos. The system accepts image uploads, validates them asynchronously, stores originals and derived assets, and exposes accepted/rejected image states to a React frontend with live status updates.

The core product requirement is not simply "file upload"; it is controlled image intake with objective validation outcomes and clear rejection reasons.

## System Overview

The repository is a JavaScript monorepo:

- `frontend/`: React + Vite UI for selecting images, local previews, live status, and accepted/rejected lists.
- `backend/`: Node/Express API, upload orchestration, validation worker, storage adapters, and metadata stores.
- `packages/shared/`: shared statuses, validation thresholds, format helpers, and presentation helpers.

The backend owns all trusted decisions:

- whether an upload ticket can be created
- whether the uploaded bytes are valid
- which status an image receives
- which storage keys and metadata are persisted
- whether a media URL/token can be used

The frontend performs early validation for user experience only. Backend validation remains authoritative.

## Upload Flow

1. The frontend sends file metadata to `POST /api/images`.
2. The backend checks basic upload eligibility:
   - allowed extension and MIME type
   - minimum upload size
   - maximum upload size
   - per-IP upload-ticket rate limit
3. The backend creates an image record and one short-lived upload token.
4. The frontend uploads bytes to `PUT /api/uploads/:token`.
5. The backend writes the original object to storage and queues a processing job.
6. The worker validates the image asynchronously.
7. The worker writes validation results, final image status, and derived assets.
8. The frontend receives SSE updates from `GET /api/events` and refreshes image lists.

### Why uploads still go through the backend

The current MinIO integration intentionally keeps upload bytes flowing through the backend instead of issuing browser-to-MinIO presigned PUTs.

This keeps the security model simple:

- upload size/type checks run before storage write
- upload tokens are consumed server-side
- malformed uploads do not directly reach object storage
- rate limiting can happen before object creation
- MinIO CORS setup is not required yet

Direct browser-to-MinIO uploads can be added later, but that requires CORS, presigned PUTs, and a completion callback endpoint that verifies the object before queueing processing.

## Metadata Persistence

The app supports two metadata backends:

- `FileStore`: local JSON-backed metadata at `backend/data/store.json`.
- `PrismaStore`: PostgreSQL-backed metadata via Prisma.

Runtime selection:

```env
STORE_DRIVER=file
STORE_DRIVER=prisma
```

`FileStore` exists for simple local fallback and tests. `PrismaStore` is the intended durable store for development with Docker Compose and for production-like environments.

### PostgreSQL schema

The Prisma schema models:

- `Image`: canonical image record and lifecycle status.
- `ImageVersion`: derived outputs such as normalized and thumbnail assets.
- `ValidationResult`: immutable validation results and diagnostics.
- `ProcessingJob`: Postgres-backed job queue records.
- `UploadToken`: short-lived upload authorization tokens.
- `MediaToken`: short-lived private media access tokens.

Indexes are included for:

- image listing by status and creation time
- duplicate hash lookup
- image version lookup
- validation history lookup
- queued job claiming

### Queue design

The worker uses the store abstraction to claim queued jobs. The Prisma implementation performs claim/update inside a transaction and updates only queued jobs, which prevents normal double-claim races when multiple workers poll concurrently.

This is good enough for a small Postgres-backed queue. For heavy production load, this should be upgraded to explicit row locking with `FOR UPDATE SKIP LOCKED` or a dedicated queue.

## Object Storage

The app supports two object storage backends:

- `LocalStorage`: stores bytes under `backend/data/storage`.
- `MinioStorage`: stores bytes in a MinIO bucket using the S3-compatible AWS SDK.

Runtime selection:

```env
STORAGE_DRIVER=local
STORAGE_DRIVER=minio
```

MinIO config:

```env
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_REGION=us-east-1
MINIO_BUCKET=image-uploads
MINIO_ACCESS_KEY_ID=minioadmin
MINIO_SECRET_ACCESS_KEY=minioadmin
MINIO_FORCE_PATH_STYLE=true
```

### Storage keys

Original uploads:

```text
originals/:imageId/:originalFileName
```

Derived assets:

```text
derived/:imageId/:baseName.normalized.:ext
derived/:imageId/:baseName.thumb.png
```

No object is publicly exposed. The backend mints short-lived media tokens and streams the object through `GET /api/media/:token`.

## Validation Pipeline

Validation is performed by the worker after upload.

Rules:

1. Reject images that are too small by file size or resolution.
2. Reject images not in JPG/JPEG, PNG, or HEIC format.
3. Reject images too similar to an existing accepted image.
4. Reject blurry images.
5. Reject images with no detected face.
6. Reject images where the single detected face is too small.
7. Reject images containing multiple faces.

The extra `no_face_detected` rule is necessary because accepting a zero-face image would defeat the intent of face/photo validation.

### Format validation

Accepted extensions:

```text
.jpg, .jpeg, .png, .heic
```

Accepted MIME types:

```text
image/jpeg, image/png, image/heic
```

The backend also sniffs actual bytes using `file-type` and decodes image metadata with `sharp`.

### Size and resolution

Current thresholds live in `packages/shared/src/index.js`:

```js
maxUploadBytes: 12 * 1024 * 1024
minUploadBytes: 10 * 1024
minWidth: 512
minHeight: 512
maxWidth: 8000
maxHeight: 8000
```

The `512x512` minimum was chosen because legitimate portrait uploads such as `596x787` should not be rejected solely for being narrower than `640`.

### Blur scoring

Blur is estimated with variance of a Laplacian-like operator over a downsampled grayscale matrix. This is deterministic and fast.

Current threshold:

```js
blurVarianceThreshold: 1.5
```

This should be calibrated with real product datasets before production use.

### Similarity detection

The worker computes a perceptual hash using low-frequency DCT values and compares it against hashes from accepted images.

Current threshold:

```js
duplicateHashDistanceThreshold: 8
```

If the Hamming distance is below the threshold, the image is rejected as too similar.

### Face detection

The project originally used a skin-color heuristic. That was intentionally replaced because it produced bad outcomes:

- accepted non-face images when no skin-like region existed
- rejected valid selfies because skin fragments were counted as multiple faces

The backend now uses `@vladmandic/face-api` with the bundled SSD MobileNet model and TensorFlow.js WASM backend.

Face acceptance rule:

- `0 faces`: reject as `no_face_detected`
- `>1 faces`: reject as `multiple_faces`
- `1 face`: accept only if:
  - face box area is at least `2%` of image area
  - face box width is at least `10%` of image width

Current thresholds:

```js
minFaceCoverageRatio: 0.02
minFaceWidthRatio: 0.1
faceDetectionMinConfidence: 0.35
faceDetectionMaxPixels: 1024
```

The face model is loaded once per backend process and reused by validation calls.

## Security and Abuse Controls

Current controls:

- strict allowed formats
- max upload size
- minimum upload size
- upload tokens with expiry
- one-time upload token consumption
- private object access
- media tokens with expiry
- per-IP upload-ticket rate limit

Default upload-ticket rate limit:

```env
MAX_UPLOAD_TICKETS_PER_HOUR=60
```

### Cost and abuse implications

Using local MinIO does not create AWS S3 charges.

However, a public deployment can still incur costs or resource exhaustion through:

- server disk usage
- database growth
- CPU-heavy face detection
- image processing load
- network bandwidth

Before exposing this publicly, add:

- authentication
- per-user quotas
- reverse-proxy request body limits
- stricter IP rate limits
- cleanup/lifecycle jobs for rejected and abandoned uploads
- monitoring and alerts
- optional CAPTCHA or bot protection for anonymous uploads

## Local Infrastructure

Docker Compose provides:

- PostgreSQL on `127.0.0.1:5432`
- MinIO API on `127.0.0.1:9000`
- MinIO Console on `127.0.0.1:9001`

Setup:

```bash
cp .env.example .env
docker compose up -d
npm run prisma:db-push -w backend
npm run dev
```

MinIO console credentials:

```text
minioadmin / minioadmin
```

## Current Integration Status

Implemented:

- MinIO storage adapter
- Prisma/Postgres metadata adapter
- Docker Compose for Postgres + MinIO
- environment-based driver selection
- Prisma schema for metadata, tokens, versions, validation results, and jobs
- local fallback stores for tests

Validated:

- local fallback tests pass
- build passes
- Prisma schema validates
- Docker Compose starts Postgres and MinIO after OrbStack is running

Open issue observed during local validation:

- `prisma db push` from the host returned `P1010` despite the container database being reachable internally.
- The issue appears related to host TCP auth/routing under the local Docker/OrbStack setup, not the Prisma schema itself.
- Next debugging step is direct Prisma Client connectivity from host and, if needed, moving Postgres to an alternate host port or using the OrbStack service hostname.

## Future Work

High priority:

- finish host Prisma connectivity validation
- add an end-to-end test against Postgres + MinIO
- add auth and per-user quotas before public deployment
- add cleanup job for abandoned uploads and expired tokens

Medium priority:

- implement direct browser-to-MinIO presigned uploads
- add MinIO CORS config
- add pagination for image lists
- add admin controls for validation thresholds
- add structured logging for worker failures

Longer term:

- replace polling worker with a more robust queue strategy
- add object lifecycle policies
- add metrics for validation latency and rejection reasons
- add background deletion of objects for soft-deleted records
