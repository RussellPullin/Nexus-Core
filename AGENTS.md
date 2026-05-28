# AGENTS.md

## Cursor Cloud specific instructions

### Architecture

- **Monorepo**: `client/` (React + Vite SPA), `server/` (Express API + SQLite), `azure-email-function/` (optional)
- Database: SQLite at `data/schedule.db` (auto-created on server start)
- Auth: Local email/password (SQLite) when `VITE_PREFER_LOCAL_LOGIN=true` in `client/.env`

### Running the app

```bash
npm run dev          # starts Express (port 3080) + Vite (port 5174) via concurrently
```

The Vite dev server proxies `/api` requests to the Express backend at `http://127.0.0.1:3080`.

### Environment files

- `.env` at repo root (server config) — copy from `.env.example`
- `client/.env` (Vite browser vars) — copy from `client/.env.example`
- Set `VITE_PREFER_LOCAL_LOGIN=true` in `client/.env` to bypass Supabase auth for local dev

### Key commands

| Task | Command |
|------|---------|
| Dev (both) | `npm run dev` |
| Lint (client) | `cd client && npm run lint` |
| Tests (server) | `npm run test:server` |
| Server syntax check | `npm run verify:server-syntax` |
| Build (client) | `npm run build` |

### Gotchas

- The `server/src/data/serviceAgreementSpring2V3/` directory contains form template data files (`fieldCatalog.js`, `variableSchema.js`, `buildMasterPayload.js`). These must exist for the server to start; they export constants used by the form template system.
- The server `PORT` is set to 3080 via the npm script (overriding the default 3001 in code).
- In development mode, `SESSION_SECRET` does not need to be strong (unlike production which enforces 32+ chars).
- The first user to register becomes `admin` and creates the anchor organisation.
- Client lint has pre-existing warnings/errors (unused vars, missing deps in hooks) — these are not blockers.
- `npm install` at root triggers `postinstall` which runs `cd server && npm install` automatically; client deps must be installed separately with `cd client && npm install`.
