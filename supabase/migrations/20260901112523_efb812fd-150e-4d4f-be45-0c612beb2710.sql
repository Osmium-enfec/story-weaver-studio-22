CREATE TABLE IF NOT EXISTS app.part_reviews (
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

CREATE INDEX IF NOT EXISTS part_reviews_course_idx ON app.part_reviews (course_id);