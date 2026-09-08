import { pgQuery } from "@/lib/pg";
import {
  rowToPartReview,
  partAssigneeFromRawParts,
  partReviewerFromRawParts,
  type PartReviewRow,
  type PartReviewInput,
} from "@/lib/review-db";

const COLS = `project_id, part_id, course_id, script_status, recording_status,
  review_status, issues_found, correction_status, assignee_email,
  COALESCE(review_doc_url,'') AS review_doc_url,
  COALESCE(review_doc_name,'') AS review_doc_name,
  rendered_uploaded,
  COALESCE(workflow_status,'') AS workflow_status,
  COALESCE(workflow_by_email,'') AS workflow_by_email,
  COALESCE(workflow_at::text,'') AS workflow_at,
  COALESCE(progress_status,'pending') AS progress_status,
  updated_by_email, updated_at::text AS updated_at`;

let colsReady: Promise<void> | null = null;

/** Older deploys predate the review document columns. */
async function ensureDocColumns(): Promise<void> {
  if (!colsReady) {
    colsReady = (async () => {
      await pgQuery(
        `ALTER TABLE part_reviews ADD COLUMN IF NOT EXISTS review_doc_url TEXT NOT NULL DEFAULT ''`,
      );
      await pgQuery(
        `ALTER TABLE part_reviews ADD COLUMN IF NOT EXISTS review_doc_name TEXT NOT NULL DEFAULT ''`,
      );
      await pgQuery(
        `ALTER TABLE part_reviews ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT ''`,
      );
      await pgQuery(
        `ALTER TABLE part_reviews ADD COLUMN IF NOT EXISTS workflow_by_email TEXT NOT NULL DEFAULT ''`,
      );
      await pgQuery(
        `ALTER TABLE part_reviews ADD COLUMN IF NOT EXISTS workflow_at TIMESTAMPTZ`,
      );
      await pgQuery(
        `ALTER TABLE part_reviews ADD COLUMN IF NOT EXISTS progress_status TEXT NOT NULL DEFAULT 'pending'`,
      );
    })().catch((e) => {
      colsReady = null;
      throw e;
    });
  }
  await colsReady;
}

export async function pgListCourseReviews(
  courseId: string,
): Promise<PartReviewRow[]> {
  await ensureDocColumns();
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM part_reviews WHERE course_id = $1`,
    [courseId],
  );
  return res.rows.map(rowToPartReview);
}

export async function pgUpsertReview(
  input: PartReviewInput,
): Promise<PartReviewRow> {
  await ensureDocColumns();
  const now = new Date().toISOString();
  // NOTE: the SQL proxy only returns rows for SELECT/WITH statements, so we
  // cannot use RETURNING here — re-read the row after writing instead.
  await pgQuery(
    `INSERT INTO part_reviews (
       project_id, part_id, course_id, script_status, recording_status,
       review_status, issues_found, correction_status, assignee_email,
       review_doc_url, review_doc_name,
       rendered_uploaded, workflow_status, workflow_by_email, workflow_at,
       progress_status, updated_by_email, updated_at
     ) VALUES ($1,$2,$3,
       COALESCE($4,''),COALESCE($5,''),COALESCE($6,''),COALESCE($7,''),
       COALESCE($8,''),COALESCE($9,''),COALESCE($13,''),COALESCE($14,''),
       COALESCE($10,''),
       COALESCE($15,''),
       CASE WHEN $15 IS NULL THEN '' ELSE COALESCE($11,'') END,
       CASE WHEN $15 IS NULL THEN NULL ELSE $12::timestamptz END,
       COALESCE($16,'pending'),
       $11,$12::timestamptz)
     ON CONFLICT (project_id, part_id) DO UPDATE SET
       course_id = EXCLUDED.course_id,
       script_status = COALESCE($4, part_reviews.script_status),
       recording_status = COALESCE($5, part_reviews.recording_status),
       review_status = COALESCE($6, part_reviews.review_status),
       issues_found = COALESCE($7, part_reviews.issues_found),
       correction_status = COALESCE($8, part_reviews.correction_status),
       assignee_email = COALESCE($9, part_reviews.assignee_email),
       review_doc_url = COALESCE($13, part_reviews.review_doc_url),
       review_doc_name = COALESCE($14, part_reviews.review_doc_name),
       rendered_uploaded = COALESCE($10, part_reviews.rendered_uploaded),
       workflow_status = COALESCE($15, part_reviews.workflow_status),
       workflow_by_email = CASE WHEN $15 IS NULL
         THEN part_reviews.workflow_by_email ELSE COALESCE($11,'') END,
       workflow_at = CASE WHEN $15 IS NULL
         THEN part_reviews.workflow_at ELSE $12::timestamptz END,
       progress_status = COALESCE($16, part_reviews.progress_status),
       updated_by_email = EXCLUDED.updated_by_email,
       updated_at = EXCLUDED.updated_at`,
    [
      input.project_id,
      input.part_id,
      input.course_id ?? null,
      input.script_status ?? null,
      input.recording_status ?? null,
      input.review_status ?? null,
      input.issues_found ?? null,
      input.correction_status ?? null,
      input.assignee_email ?? null,
      input.rendered_uploaded ?? null,
      input.updated_by_email ?? null,
      now,
      input.review_doc_url ?? null,
      input.review_doc_name ?? null,
      input.workflow_status ?? null,
      input.progress_status ?? null,
    ],
  );
  const saved = await pgGetReview(input.project_id, input.part_id);
  if (!saved) throw new Error("Review save failed");
  return saved;
}


export async function pgPartComposerEmail(
  projectId: string,
  partId: string,
): Promise<string | null> {
  const res = await pgQuery<{ parts: unknown }>(
    `SELECT parts FROM projects WHERE id = $1`,
    [projectId],
  );
  const raw = res.rows[0]?.parts;
  const parsed = typeof raw === "string" ? safeParse(raw) : raw;
  return partAssigneeFromRawParts(parsed, partId);
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

export async function pgPartReviewerEmail(
  projectId: string,
  partId: string,
): Promise<string | null> {
  const res = await pgQuery<{ parts: unknown }>(
    `SELECT parts FROM projects WHERE id = $1`,
    [projectId],
  );
  const raw = res.rows[0]?.parts;
  const parsed = typeof raw === "string" ? safeParse(raw) : raw;
  return partReviewerFromRawParts(parsed, partId);
}

export async function pgGetReview(
  projectId: string,
  partId: string,
): Promise<PartReviewRow | null> {
  await ensureDocColumns();
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM part_reviews WHERE project_id = $1 AND part_id = $2`,
    [projectId, partId],
  );
  const row = res.rows[0];
  return row ? rowToPartReview(row) : null;
}

/** All part workflow statuses (admin overview). */
export async function pgListAllWorkflowStatuses(): Promise<
  Array<{ project_id: string; part_id: string; workflow_status: string }>
> {
  await ensureDocColumns();
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT project_id, part_id, COALESCE(workflow_status,'') AS workflow_status
     FROM part_reviews`,
  );
  return res.rows.map((r) => ({
    project_id: String(r.project_id),
    part_id: String(r.part_id),
    workflow_status: String(r.workflow_status ?? ""),
  }));
}
