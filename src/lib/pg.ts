import pg from "pg";
import { postgresUrl } from "@/lib/runtime-backends";

let pool: pg.Pool | null = null;
let schemaPromise: Promise<void> | null = null;

/** Matches migrations/001_init.sql — embedded so prod boots even if the file is missing. */
export const PG_SCHEMA_SQL = `
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
`;

/**
 * DO Managed Postgres uses a private CA. Newer `pg` maps sslmode=require →
 * verify-full, which rejects that chain. Strip sslmode from the URL and set
 * ssl explicitly so PG_SSL_REJECT_UNAUTHORIZED=0 can work.
 */
export function pgConnectionOptions(connectionString: string): pg.PoolConfig {
  const raw = connectionString.trim();
  const isLocal = /localhost|127\.0\.0\.1/.test(raw);
  let url = raw.replace(/([?&])sslmode=[^&]*/gi, "$1").replace(/\?&/, "?").replace(/[?&]$/, "");
  const pgSsl = (process.env.PG_SSL ?? "").trim();
  if (pgSsl === "0" || isLocal) {
    return { connectionString: url, ssl: false };
  }
  // Trim — Droplet/nano saves often leave trailing spaces/CRLF, which would
  // keep rejectUnauthorized=true and break DO Managed Postgres (private CA).
  const rejectUnauthorized =
    (process.env.PG_SSL_REJECT_UNAUTHORIZED ?? "").trim() !== "0";
  return { connectionString: url, ssl: { rejectUnauthorized } };
}

/** Shared pool — only used when DATABASE_URL is set (prod / Docker). */
export function getPgPool(): pg.Pool {
  const url = postgresUrl();
  if (!url) {
    throw new Error("DATABASE_URL is not set — Postgres backend is inactive.");
  }
  if (!pool) {
    pool = new pg.Pool({
      ...pgConnectionOptions(url),
      max: Number(process.env.PG_POOL_MAX ?? 10),
    });
  }
  return pool;
}

/** Create tables/indexes if missing. Safe to call repeatedly. */
export async function ensurePgSchema(): Promise<void> {
  if (!postgresUrl()) return;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await getPgPool().query(PG_SCHEMA_SQL);
      console.log("[pg] schema ensured");
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

export async function pgQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  await ensurePgSchema();
  return getPgPool().query<T>(text, params);
}
