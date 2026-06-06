# Image Upload Validation Platform

Monorepo with:

- `backend/`: Express API, upload orchestration, validation worker, SSE updates.
- `frontend/`: React + Vite app for upload, live status, accepted/rejected queues.
- `packages/shared/`: shared statuses, thresholds, and validation helpers.

## Local dev

```bash
npm install
npm run dev
```

The backend can run with local JSON/disk storage or with Postgres + MinIO.

For Postgres + MinIO:

```bash
cp .env.example .env
docker compose up -d
npm run prisma:db-push -w backend
npm run dev
```

MinIO console: `http://127.0.0.1:9001`

Default local credentials are `minioadmin` / `minioadmin`.
