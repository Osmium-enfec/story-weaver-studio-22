-- Per-course theme: background loop, intro/outro bumpers, narration voice.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS settings JSONB;
