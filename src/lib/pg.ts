import pg from "pg";
import {
  postgresUrl,
  useCloudRest,
  usingCloudPostgres,
  useSqlProxy,
  sqlProxyUrl,
} from "@/lib/runtime-backends";

/** Cloud fallback (managed DB) keeps app tables in the private `app` schema. */
function usingCloudFallback(): boolean {
  return usingCloudPostgres();
}


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

CREATE TABLE IF NOT EXISTS episode_reviews (
  project_id TEXT PRIMARY KEY,
  course_id TEXT,
  parts_checked TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT '',
  issues_found TEXT NOT NULL DEFAULT '',
  correction_status TEXT NOT NULL DEFAULT '',
  assignee_email TEXT NOT NULL DEFAULT '',
  rendered_uploaded TEXT NOT NULL DEFAULT '',
  updated_by_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS episode_reviews_course_idx
  ON episode_reviews (course_id);

CREATE TABLE IF NOT EXISTS part_reviews (
  project_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  course_id TEXT,
  script_status TEXT NOT NULL DEFAULT '',
  recording_status TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT '',
  issues_found TEXT NOT NULL DEFAULT '',
  correction_status TEXT NOT NULL DEFAULT '',
  assignee_email TEXT NOT NULL DEFAULT '',
  rendered_uploaded TEXT NOT NULL DEFAULT '',
  updated_by_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, part_id)
);

CREATE INDEX IF NOT EXISTS part_reviews_course_idx
  ON part_reviews (course_id);

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
  // The managed cloud database (no explicit DATABASE_URL) also presents a
  // private CA chain, so don't verify it unless explicitly asked to.
  const rejectUnauthorized = (process.env.PG_SSL_REJECT_UNAUTHORIZED ?? "").trim() === "1";


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
      ...(usingCloudFallback() ? { options: "-c search_path=app,public" } : {}),
      max: Number(process.env.PG_POOL_MAX ?? 10),
    });
  }
  return pool;
}

/** Create tables/indexes if missing. Safe to call repeatedly. */
export async function ensurePgSchema(): Promise<void> {
  if (useCloudRest()) return;
  if (!postgresUrl()) return;
  // Cloud fallback: schema is provisioned by migration; the app role cannot DDL.
  if (usingCloudFallback()) return;
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

/**
 * Hosted/edge runtime has no raw TCP Postgres access and no connection string,
 * so queries go through the service-role-only `app_exec_sql` RPC instead.
 */
async function restQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("app_exec_sql" as never, {
    q: text,
    params: (params ?? []).map((p) =>
      p === null || p === undefined ? null : typeof p === "string" ? p : String(p),
    ),
  } as never);
  if (error) throw new Error(error.message);
  const payload = (data ?? { rows: [], rowCount: 0 }) as {
    rows: T[];
    rowCount: number;
  };
  return {
    rows: payload.rows ?? [],
    rowCount: payload.rowCount ?? 0,
    command: "",
    oid: 0,
    fields: [],
  } as unknown as pg.QueryResult<T>;
}

/**
 * Edge runtime (published Lovable app): forward SQL over HTTPS to the
 * self-hosted app, which has raw TCP access to the DO Postgres. Keeps both
 * deployments on one database.
 */
async function proxyQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const res = await fetch(sqlProxyUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SQL_PROXY_SECRET?.trim() ?? ""}`,
    },
    body: JSON.stringify({ text, params: params ?? [] }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    rows?: T[];
    rowCount?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(payload.error ?? `SQL proxy failed (${res.status})`);
  return {
    rows: payload.rows ?? [],
    rowCount: payload.rowCount ?? 0,
    command: "",
    oid: 0,
    fields: [],
  } as unknown as pg.QueryResult<T>;
}

export async function pgQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  if (useSqlProxy()) return proxyQuery<T>(text, params);
  if (useCloudRest()) return restQuery<T>(text, params);
  await ensurePgSchema();

  return getPgPool().query<T>(text, params);
}
