-- Persist in-progress workshop state (plans, current scene) across refresh.
alter table public.projects
  add column if not exists workshop_draft jsonb;
