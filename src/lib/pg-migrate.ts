import { getPgPool } from "@/lib/pg";

/**
 * Postgres schema bootstrap.
 *
 * The SQLite backend creates its tables on demand (`CREATE TABLE IF NOT EXISTS`
 * inside each `getDb()`), so a fresh LAN checkout just works. The Postgres
 * backend had no equivalent: `migrations/001_init.sql` was only ever applied by
 * hand (`psql -f ...`) or as a side effect of `scripts/migrate-local-to-do.mjs`.
 * A Droplet started with `DATABASE_URL` set but the schema never applied failed
 * every query with `42P01 relation "users" does not exist`.
 *
 * This module closes that gap: migrations are applied once per database, from
 * the app itself, before the first query runs.
 *
 * `SQL_001_INIT` is the authoritative copy of `migrations/001_init.sql` — the
 * two must stay in sync. It is inlined rather than read from disk because the
 * server runs as a bundled Nitro output where `migrations/` is not a guaranteed
 * runtime path.
 */

const SQL_001_INIT = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS courses_user_updated_idx
  ON courses (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  script TEXT,
  audio_mode TEXT NOT NULL DEFAULT 'tts',
  scenes JSONB NOT NULL DEFAULT '[]'::jsonb,
  parts JSONB NOT NULL DEFAULT '[]'::jsonb,
  thumbnail_url TEXT,
  course_id TEXT,
  assigned_user_id TEXT,
  assigned_user_email TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_user_updated_idx
  ON projects (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS projects_user_course_idx
  ON projects (user_id, course_id);
CREATE INDEX IF NOT EXISTS projects_assigned_user_idx
  ON projects (assigned_user_id);
CREATE INDEX IF NOT EXISTS projects_parts_gin_idx
  ON projects USING GIN (parts);

CREATE TABLE IF NOT EXISTS image_assets (
  id TEXT PRIMARY KEY,
  prompt TEXT,
  kind TEXT,
  public_url TEXT,
  embedding TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS image_assets_kind_idx ON image_assets (kind);
`;

interface Migration {
  name: string;
  sql: string;
}

/** Applied in order, once each, recorded in `schema_migrations`. */
const MIGRATIONS: Migration[] = [{ name: "001_init", sql: SQL_001_INIT }];

/** Fixed key so replicas serialize schema work instead of racing on DDL. */
const MIGRATION_LOCK_KEY = 4819233015;

let migratePromise: Promise<void> | null = null;

function autoMigrateDisabled(): boolean {
  const raw = process.env.PG_AUTO_MIGRATE?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

/**
 * Apply pending migrations. Safe to call before every query — runs at most once
 * per process, and a failed attempt is not cached so the next request retries
 * (the database may simply not be reachable yet at boot).
 */
export async function ensurePgSchema(): Promise<void> {
  if (autoMigrateDisabled()) return;
  if (!migratePromise) {
    migratePromise = runMigrations().catch((error) => {
      migratePromise = null;
      throw error;
    });
  }
  return migratePromise;
}

async function runMigrations(): Promise<void> {
  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN");
    try {
      // Taken before any DDL: concurrent `CREATE TABLE IF NOT EXISTS` from a
      // second container can otherwise fail on the pg_type unique index.
      // Released on commit/rollback.
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      const appliedRes = await client.query<{ name: string }>(
        `SELECT name FROM schema_migrations`,
      );
      const applied = new Set(appliedRes.rows.map((r) => r.name));
      const pending = MIGRATIONS.filter((m) => !applied.has(m.name));

      for (const migration of pending) {
        await client.query(migration.sql);
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [
          migration.name,
        ]);
        console.log(`[pg] applied migration ${migration.name}`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}
