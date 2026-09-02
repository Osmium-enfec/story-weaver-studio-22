# Deploy on DigitalOcean (without touching LAN)

This branch adds Docker / Node production packaging and dual backends.
**Your Mac LAN server keeps using SQLite + `.data/` as long as `DATABASE_URL` and Spaces vars are unset.**

Work happens in the `divStudio-do-deploy` git worktree (`feature/do-postgres-spaces`).
The LAN checkout stays on `feature/course-episode-ai-scripting` (or `main`) with the existing `npm run dev:lan`.

## Phase 1 — Droplet with Docker (still SQLite on a volume)

1. Create a Droplet (Ubuntu 24.04, 4–8 GB) and install Docker.
2. Clone this branch on the Droplet (or `scp` / CI build).
3. Copy env:
   ```bash
   cp .env.production.example .env.production
   # fill API keys + ADMIN_* ; leave DATABASE_URL / SPACES_* commented for now
   ```
4. Build and run:
   ```bash
   docker compose up -d --build
   curl http://127.0.0.1:3000/api/health
   ```
5. Put Nginx/Caddy + TLS in front; set `EXPORT_BASE_URL=https://your-host`.

Local Mac is unchanged.

## Phase 2 — Managed Postgres + Spaces

1. Create DO Managed Postgres + Spaces bucket + API keys (same region).
2. Schema: nothing to do. With `DATABASE_URL` set, the app applies
   `migrations/001_init.sql` itself on the first query and records it in
   `schema_migrations`. To apply it by hand instead, run it and set
   `PG_AUTO_MIGRATE=0`:
   ```bash
   psql "$DATABASE_URL" -f migrations/001_init.sql
   ```
3. Snapshot LAN data **without removing it**:
   ```bash
   # on Mac, from worktree — COPY only
   cp -a ../divStudio/.data ./migrate-data
   ```
4. Run migrator against the copy:
   ```bash
   DATA_ROOT=./migrate-data \
   DATABASE_URL=... SPACES_ENDPOINT=... SPACES_REGION=... \
   SPACES_BUCKET=... SPACES_KEY=... SPACES_SECRET=... \
   node scripts/migrate-local-to-do.mjs --dry-run
   # then without --dry-run
   ```
5. Uncomment `DATABASE_URL` + Spaces vars in Droplet `.env.production`, recreate the app container.
6. Smoke-test Droplet URL. Keep LAN running until you trust prod.

## Backend switches

| Env | Effect |
|---|---|
| no `DATABASE_URL` | SQLite (`ENFEC_DATA_ROOT` / `.data`) — **local LAN default** |
| `DATABASE_URL` set | Postgres (`pg-auth-db` / `pg-projects-db` / `pg-courses-db`), schema auto-applied |
| `PG_AUTO_MIGRATE=0` | Skip auto-schema; you apply `migrations/` yourself |
| no Spaces vars | Disk under `project-assets` / `app-assets` |
| Spaces vars set | Object storage; app URLs stay `/api/assets/...` |

Auth, projects, courses, asset persist/serve, recording2, extract-audio, and export asset materialization all honor these switches. Leave prod env vars **out** of the Mac `.env` used by `dev:lan`.

## Migrating data off Lovable Cloud onto your own Postgres

Media files stay in Spaces — only DB rows move.

```bash
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
DATABASE_URL=postgres://user:pass@<do-host>:25060/<db>?sslmode=require \
node scripts/migrate-cloud-to-do.mjs --dry-run   # then without --dry-run
```

- Copies users, sessions (skip with `--skip-sessions`), courses, projects
  (scenes/parts sliced in 1 MB reads + chunked writes), image_assets,
  episode_reviews, part_reviews.
- Fully resumable: upserts everywhere; big projects already migrated are skipped.
- After it finishes, set `DATABASE_URL` + Spaces vars on the droplet app and smoke-test.

## What not to do

- Do not put prod secrets in the Mac `.env` used by `dev:lan`
- Do not delete or move the live `.data` folder for migration — always copy
- Do not stop the LAN server to “make room” for Docker on the same Mac unless you intend to

## Code location

Deploy work lives in the `divStudio-do-deploy` git worktree on branch `feature/do-postgres-spaces`.
LAN checkout stays on its previous branch with the existing `npm run dev:lan`.
