import { pgQuery } from "@/lib/pg";
import {
  rowToPartReview,
  partAssigneeFromRawParts,
  type PartReviewRow,
  type PartReviewInput,
} from "@/lib/review-db";

const COLS = `project_id, part_id, course_id, script_status, recording_status,
  review_status, issues_found, correction_status, assignee_email,
  rendered_uploaded, updated_by_email, updated_at::text AS updated_at`;

export async function pgListCourseReviews(
  courseId: string,
): Promise<PartReviewRow[]> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM part_reviews WHERE course_id = $1`,
    [courseId],
  );
  return res.rows.map(rowToPartReview);
}

export async function pgUpsertReview(
  input: PartReviewInput,
): Promise<PartReviewRow> {
  const now = new Date().toISOString();
  const res = await pgQuery<Record<string, unknown>>(
    `INSERT INTO part_reviews (
       project_id, part_id, course_id, script_status, recording_status,
       review_status, issues_found, correction_status, assignee_email,
       rendered_uploaded, updated_by_email, updated_at
     ) VALUES ($1,$2,$3,
       COALESCE($4,''),COALESCE($5,''),COALESCE($6,''),COALESCE($7,''),
       COALESCE($8,''),COALESCE($9,''),COALESCE($10,''),$11,$12::timestamptz)
     ON CONFLICT (project_id, part_id) DO UPDATE SET
       course_id = EXCLUDED.course_id,
       script_status = COALESCE($4, part_reviews.script_status),
       recording_status = COALESCE($5, part_reviews.recording_status),
       review_status = COALESCE($6, part_reviews.review_status),
       issues_found = COALESCE($7, part_reviews.issues_found),
       correction_status = COALESCE($8, part_reviews.correction_status),
       assignee_email = COALESCE($9, part_reviews.assignee_email),
       rendered_uploaded = COALESCE($10, part_reviews.rendered_uploaded),
       updated_by_email = EXCLUDED.updated_by_email,
       updated_at = EXCLUDED.updated_at
     RETURNING ${COLS}`,
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
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error("Review save failed");
  return rowToPartReview(row);
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
