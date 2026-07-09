
-- pgvector for semantic image cache
create extension if not exists vector;

-- ============ image_assets: GLOBAL image cache ============
create table public.image_assets (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  kind text not null check (kind in ('background','element')),
  storage_path text not null,
  public_url text not null,
  embedding vector(1536) not null,
  created_by uuid references auth.users(id) on delete set null,
  usage_count integer not null default 1,
  created_at timestamptz not null default now()
);

grant select, insert, update on public.image_assets to authenticated;
grant all on public.image_assets to service_role;

alter table public.image_assets enable row level security;

create policy "image_assets: any authenticated user can read"
  on public.image_assets for select to authenticated using (true);

create policy "image_assets: authenticated users can insert"
  on public.image_assets for insert to authenticated
  with check (auth.uid() = created_by);

create policy "image_assets: authenticated users can bump usage"
  on public.image_assets for update to authenticated
  using (true) with check (true);

create index image_assets_embedding_idx
  on public.image_assets using hnsw (embedding vector_cosine_ops);

create index image_assets_kind_idx on public.image_assets (kind);

-- Match function: returns best match above similarity threshold for a kind.
create or replace function public.match_image_asset(
  query_embedding vector(1536),
  match_kind text,
  match_threshold float default 0.88
)
returns table (id uuid, public_url text, similarity float)
language sql stable
set search_path = public
as $$
  select a.id, a.public_url, 1 - (a.embedding <=> query_embedding) as similarity
  from public.image_assets a
  where a.kind = match_kind
    and 1 - (a.embedding <=> query_embedding) >= match_threshold
  order by a.embedding <=> query_embedding
  limit 1;
$$;

-- Bump usage counter
create or replace function public.bump_image_asset_usage(asset_id uuid)
returns void language sql
set search_path = public
as $$
  update public.image_assets set usage_count = usage_count + 1 where id = asset_id;
$$;

-- ============ projects: user's saved videos ============
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  script text,
  audio_mode text not null default 'tts' check (audio_mode in ('tts','upload')),
  scenes jsonb not null default '[]'::jsonb,
  thumbnail_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.projects to authenticated;
grant all on public.projects to service_role;

alter table public.projects enable row level security;

create policy "projects: owner select" on public.projects
  for select to authenticated using (auth.uid() = user_id);
create policy "projects: owner insert" on public.projects
  for insert to authenticated with check (auth.uid() = user_id);
create policy "projects: owner update" on public.projects
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "projects: owner delete" on public.projects
  for delete to authenticated using (auth.uid() = user_id);

create index projects_user_id_idx on public.projects (user_id, updated_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql
set search_path = public
as $$ begin new.updated_at = now(); return new; end $$;

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();
