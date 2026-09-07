# Episode reviewers and a part review workflow

Add a reviewer role assigned per episode, plus a clear status on every part:
**Ready for review → Reviewed, ready for download → Redo**.

## How it will work

**Admin (you)**
- On an episode page (and in the admin assignment sheet) there is a new
  "Reviewer" picker next to the existing assignment picker. Pick any user
  (Balaji, Shweta, anyone) as reviewer for that whole episode.
- The reviewer instantly gets access to every part of that episode, read-only:
  they can open and watch a part, but cannot change its scenes.

**Assigned person (the one making the part)**
- The green "Ready for HD" button is replaced by **"Ready for review"**.
- It only becomes clickable once the part has been stitched and saved/updated
  (an unsaved draft cannot be sent).
- Clicking it sets the part to *Ready for review* and notifies the reviewer by
  showing it in their review queue.
- After a part comes back as *Redo*, they fix it and can send it again.

**Reviewer**
- Opens the part, watches it, and in a small review box either:
  - writes what is wrong and marks **Needs redo**, or
  - marks **Reviewed** when nothing is wrong.
- Whatever they write lands in the existing **Issues** column of the Review
  page, so nothing is duplicated.

**Everyone**
- Each part card shows a coloured badge on the thumbnail area:
  *Ready for review* (amber), *Reviewed — ready for download* (green),
  *Redo* (red), or nothing yet.
- The Review page gets a new **Stage** column with the same badge, plus who
  the reviewer is, so the whole course is visible at a glance.
- "Ready for HD" stays, but only for admins and only once a part is
  *Reviewed* — so nothing gets rendered before it passes review.

## Extras worth adding (included)

- A small "who did what, when" line on each status change (reviewer email and
  time), shown as a tooltip.
- Reviewer filter on the Review page ("only parts waiting for my review").
- Reviewers see a count badge in the top bar next to Review when parts are
  waiting for them.

## Technical notes

- **Storage**: one new column `workflow_status` on the existing `part_reviews`
  table (values `''`, `ready_for_review`, `reviewed`, `redo`), plus
  `workflow_by_email` / `workflow_at`. Added with
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `src/lib/pg-review-db.ts`
  (DigitalOcean Postgres) and in the SQLite bootstrap in `src/lib/review-db.ts`.
  No Lovable-side migration is needed since data lives in the DO database.
- **Reviewer assignment**: reuses the existing `reviewerUserId` /
  `reviewerUserEmail` fields on each part (already in `ProjectPart` and already
  honoured by `userCanAccessPart`). A new `assignEpisodeReviewer` action in
  `src/routes/api/projects.ts` writes them to all parts of an episode.
- **Permissions** (`src/lib/review-permissions.ts`): new field
  `workflow_status`; assignee may set `ready_for_review` only; part reviewer and
  admin may set `reviewed`/`redo`; reviewers may also write `issues_found` for
  their episode's parts. Enforced server-side in `src/routes/api/reviews.ts`.
- **UI**: `ComposeProjectPanel.tsx` (Ready-for-review button + reviewer box),
  `episode.$id.tsx` (reviewer picker + status badge), `review.tsx` (Stage
  column + filter), `NavBar.tsx` (pending count), `AssignmentSheet.tsx`
  (reviewer column).
- Compose edits stay blocked for reviewer-only users via `userCanEditPart`.
