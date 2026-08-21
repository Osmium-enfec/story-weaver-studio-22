CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS app.sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_token_idx ON app.sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON app.sessions (user_id);

CREATE TABLE IF NOT EXISTS app.courses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS courses_user_updated_idx ON app.courses (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS app.projects (
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
CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON app.projects (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS projects_user_course_idx ON app.projects (user_id, course_id);
CREATE INDEX IF NOT EXISTS projects_assigned_user_idx ON app.projects (assigned_user_id);

CREATE TABLE IF NOT EXISTS app.image_assets (
  id TEXT PRIMARY KEY,
  prompt TEXT,
  kind TEXT,
  public_url TEXT,
  embedding TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

-- The app schema is NOT exposed through the Data API; it is reached only by the
-- server over a direct database connection, so grant usage broadly to whichever
-- database role the deployed server connects as.
GRANT USAGE, CREATE ON SCHEMA app TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC;
REVOKE USAGE ON SCHEMA app FROM anon, authenticated;