# Plan: Persistence + Image Library + Drag-Drop

## 1. Enable Lovable Cloud
Turn on Cloud for auth, database (with pgvector), and storage.

## 2. Auth
- Email/password + Google sign-in (Google via `lovable.auth.signInWithOAuth`).
- `/auth` public route, `/projects` and `/project/$id` under `_authenticated/`.
- Home `/` stays public (script → generate demo), but "Save" requires sign-in.

## 3. Database schema (migration)
```
extension vector;

table projects (
  id uuid pk,
  user_id uuid → auth.users,
  title text,
  script text,
  audio_mode text,           -- 'tts' | 'upload'
  scenes jsonb,              -- full Scene[] with mediaUrl/audioUrl (data URLs)
  created_at, updated_at
);
RLS: owner-only CRUD.

table image_assets (            -- GLOBAL library (no user_id filter on read)
  id uuid pk,
  prompt text,
  kind text,                    -- 'background' | 'element'
  storage_path text,            -- in 'image-library' bucket
  embedding vector(1536),       -- openai text-embedding-3-small
  created_by uuid,
  usage_count int default 1,
  created_at
);
RLS:
  - authenticated can SELECT all (global reuse)
  - authenticated can INSERT (created_by = auth.uid())
  - only created_by can UPDATE/DELETE
Index: HNSW cosine on embedding.

RPC match_image_asset(query_embedding, kind, threshold, k)
returns best match above cosine similarity threshold (default 0.88).
```
Storage bucket `image-library` (public read).

## 4. Image library integration
New server fns in `src/lib/image-library.functions.ts`:
- `findOrGenerateBackground({ prompt })`:
  1. Embed prompt via `/v1/embeddings` (`text-embedding-3-small`).
  2. Call `match_image_asset` RPC (kind='background', threshold 0.88).
  3. If hit → bump `usage_count`, return public URL.
  4. Else → generate via existing gemini flow, upload PNG to `image-library` bucket, insert row with embedding, return URL.
- `findOrGenerateElement({ prompt })`: same flow, kind='element', threshold 0.9 (elements are more specific).

Update `src/routes/index.tsx` `buildScene` to call these instead of `generateSceneBackground` / `generateSceneElement` directly. Keep the old server fns as the generation primitive (called internally).

## 5. Drag-and-drop audio
In `src/routes/index.tsx` upload-audio panel:
- Wrap upload area in a div with `onDragOver`/`onDrop` handlers.
- Show dashed border, "Drop audio here or click to browse" state.
- Highlight on drag-over.
- Accept `audio/*`, reject others with toast.

## 6. Save / Load projects
- "Save Project" button after generation → prompts for title, calls `saveProject` server fn (`requireSupabaseAuth`) which inserts/updates row with full scene manifest.
- New route `/_authenticated/projects` — lists user's projects (title, date, thumbnail = first scene bg).
- New route `/_authenticated/project/$id` — loads scenes, renders `<VideoPlayer>` immediately (no regeneration).
- Nav bar: "My Projects" + user email + sign out.

## 7. UX pacing
No new work — user asked "take your time, make things good". Keep existing sequential pacing (concurrency=3), don't rush the renderer, keep the 750ms crossfade / 550ms gap.

## Technical notes
- Scenes reference data URLs today. To keep projects loadable across devices, on save: for each scene, if `mediaUrl`/`audioUrl` is a `data:` URL, upload it to a per-project storage bucket `project-assets/{projectId}/...` and rewrite to public URLs. Stock (Pexels) URLs stored as-is.
- Embeddings are cheap; run one embed per element/background prompt before the image call.
- The library grows across all users → over time image-gen calls drop dramatically for common concepts.

## Out of scope
- Public sharing of projects (owner-only for now).
- Trimming/editing scenes post-generation.
- MP4 export changes (already there).
