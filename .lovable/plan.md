# Cloud "Ready for HD" bundles (SR pattern)

Yes — all five requirements are doable on the current stack. The website stays a
studio + package server; your Mac stays the only renderer.

## What already exists

- Cloud saves work on the published site: accounts, projects → parts → scenes are in the
  cloud database, and media is served from cloud storage through `/api/assets/...`.
- Parts already carry everything an HD job needs: `scenes` (with timings/transitions),
  `masterAudioUrl`, `bgm`, background, duration.
- The HD payload shape is already defined by the existing export job (`/api/export`),
  which is what the render agent consumes today.

So the work is: freeze a snapshot, expose it over a key-protected public API, and make
every asset URL absolute + fetchable with that key.

## What gets built

### 1. Ready for HD (snapshot freeze)
- New cloud table `render_bundles`: id, project/episode id, part id, owner email,
  episode title, part title, duration, scene count, `ready_at`, `status`
  (`ready | rendering | done | failed`), frozen `payload` JSON, `output_url`.
- A **Ready for HD** button next to Save part in the editor. On click:
  - validate the part is stitched (master audio present and reachable, every scene has
    `startMs`/`endMs`, no `blob:`/`file://`/data URLs left);
  - persist any remaining ephemeral media to cloud storage;
  - rewrite every media URL in the snapshot to an absolute `https://divstudio.lovable.app/...` URL;
  - store the frozen payload. Later edits to the part do not touch the snapshot —
    re-clicking creates a new version.
  - If validation fails, the button explains exactly what is missing (same failure mode
    as SR when narration is absent) and nothing enters your queue.

### 2. Public render API (key-protected)
New secret `RENDER_API_KEY`; every route below requires `Authorization: Bearer <key>`.

- `GET /api/public/bundles` — all ready parts, every member:
  `{ id, episodeTitle, partTitle, ownerEmail, durationMs, sceneCount, readyAt, status }`
- `GET /api/public/bundles/:id` — the exact HD job:
  `{ filename, quality: "hd", masterAudioUrl, scenes, background, bgm }`
  with `filename` like `Episode 17 Part 3 Practice-1080p.mp4`.
- `POST /api/public/bundles/:id/status` — mark `rendering` / `done` / `failed`
  (prevents double-queueing).
- `PUT /api/public/bundles/:id/output` — upload the finished MP4; it is stored in cloud
  storage and shown as a download on the part in the website.

### 3. Assets downloadable from your Mac
- `/api/assets/*` accepts `Authorization: Bearer <RENDER_API_KEY>` (in addition to the
  normal session), so no browser login is needed.
- Bundle payloads only ever contain absolute HTTPS URLs — including the intro/outro
  bumpers and background loop — verified at freeze time.

### 4. Admin list page
`/admin` gains a **Ready for HD** tab: bundle list, status, re-freeze, and the finished
MP4 link. Optional for you, useful for members.

## Not built
No HD encoding on Lovable, no member-side render agent, no calls to `127.0.0.1:3850`
from the website.

## Technical notes
- Table lives in the `app` schema alongside projects; served through the existing
  cloud-REST data path so it works on the published edge runtime.
- Freeze-time URL rewriting reuses `persist-client-asset` / `object-storage`.
- `/api/public/*` bypasses site auth by design, so each handler verifies the render key
  itself with a constant-time compare and returns 401 otherwise.
