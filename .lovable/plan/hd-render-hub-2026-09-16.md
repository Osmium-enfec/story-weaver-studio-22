# HD Render Hub

Replace the two local Mac encoders with one managed render hub: parts are queued from the
studio, picked up one-by-one by any number of render machines, and the finished video comes
back to the Export page for everyone.

## Where should scheduling live?

**On the website, not on your machines.** The site keeps one ordered queue and hands out
jobs; each machine just asks "give me the next job", renders it, uploads, and asks again.

Why this way:
- Machines never talk to each other, so two machines can never grab the same part.
- You can add or shut down machines any time with zero configuration.
- Queue order, stop and delete all work from the website even when machines are offline.
- A machine that dies mid-render is detected (no heartbeat) and its job returns to the queue.

Your machines stay dumb workers: claim → render → upload → repeat.

## Removing the old Mac render system

Deleted from the app:
- The "Studio Mac / This Mac (Agent)" picker and the 720p / HD download buttons in Compose.
- The local Render Agent connection (port 3850/3851) and its online/offline status.
- Server-side FFmpeg export jobs and the old Export page built around them.

Compose keeps a single action on a reviewed part: **Send to HD render**.

## The queue

Each render job stores: episode, part, course, who queued it, a frozen copy of the part
(so later edits don't change what's rendering), status, progress, which machine took it,
last heartbeat, error message, and the finished video link.

Status flow: `queued → claimed → rendering → done`, plus `failed`, `cancelled`.

Rules:
- Queue as many as you like; machines take exactly one at a time.
- Re-queuing a part supersedes its earlier waiting job.
- Stop cancels a waiting job instantly, and tells a rendering machine to abort at its next
  progress check-in.
- A job with no heartbeat for 3 minutes goes back to the queue automatically.

## Who can do what

- **Queue a render:** reviewers and admin, on parts marked Reviewed.
- **Stop / delete a job:** whoever queued it, plus admin.
- **Delete a finished video:** admin only.
- **See everything, including finished video links:** all signed-in users.

## Export page (rebuilt)

- Course picker → episode list, **10 episodes per page**, each row expanding to its parts.
- Tabs: **Queued**, **In progress**, **Rendered**.
- In progress rows show a live progress bar, current stage, machine name and elapsed time,
  refreshed every few seconds.
- Rendered rows show the video link (play / download / copy link) and render date.
- Row actions: Stop, Delete, Re-queue; Delete video for admin.
- A small header strip shows active machines and how many jobs are waiting.

## Machine API (render key protected)

Same key style as today (`Authorization: Bearer <RENDER_API_KEY>`):

- `POST /api/public/render/claim` — atomically take the oldest waiting job; returns the full
  job payload with absolute asset URLs, or nothing if the queue is empty.
- `POST /api/public/render/:id/progress` — heartbeat with percent + stage; the response tells
  the machine to abort if the job was stopped.
- `PUT /api/public/render/:id/output` — upload the finished MP4; stored in the bucket and
  linked on the job.
- `POST /api/public/render/:id/fail` — report an error.
- `GET /api/public/render/jobs` — read-only view of the queue.

Claiming uses a single atomic database update, so concurrent machines are safe.

## Technical notes

- New table `render_jobs` (supersedes `render_bundles`), with indexes on status + queued time
  and a partial index for the claim query; existing ready bundles migrate into it as `queued`.
- Claim is `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`.
- Payload freezing reuses `render-bundle-build.server.ts` (absolute URLs, course background,
  intro/outro healing), so bundles keep working as they do now.
- Files removed: `render-agent-client.ts`, `native-export-client.ts`, `native-export-jobs.ts`,
  `api/export.ts`, `api/render-agent-updates.$.ts`, `export-runner` route and their imports.
- Export page uses React Query with a 3s poll only for the In progress tab.
