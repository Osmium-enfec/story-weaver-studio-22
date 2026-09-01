CREATE TABLE IF NOT EXISTS app.episode_reviews (
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

CREATE INDEX IF NOT EXISTS episode_reviews_course_idx ON app.episode_reviews (course_id);