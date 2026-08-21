-- Explainer Studio / divStudio — Postgres schema matching local SQLite tables.
--
-- The app applies this automatically on first query when DATABASE_URL is set
-- (see src/lib/pg-migrate.ts, which holds an inlined copy of this file — keep
-- the two in sync). Applying it by hand is optional:
--   psql "$DATABASE_URL" -f migrations/001_init.sql

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
