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

The backend defaults to a local file-backed demo store. Set `DATABASE_URL` and wire the Prisma path if you want to replace it with PostgreSQL persistence.
