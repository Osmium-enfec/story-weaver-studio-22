import { pgQuery } from "@/lib/pg";
import type { EpisodeReviewRow, EpisodeReviewInput } from "@/lib/review-db";

function rowToReview(row: Record<string, unknown>): EpisodeReviewRow {
  return {
    project_id: String(row.project_id),
    course_id: row.course_id != null ? String(row.course_id) : null,
    parts_checked: String(row.parts_checked ?? ""),
    review_status: String(row.review_status ?? ""),
    issues_found: String(row.issues_found ?? ""),
    correction_status: String(row.correction_status ?? ""),
    assignee_email: String(row.assignee_email ?? ""),
    rendered_uploaded: String(row.rendered_uploaded ?? ""),
    updated_by_email:
      row.updated_by_email != null ? String(row.updated_by_email) : null,
    updated_at: String(row.updated_at ?? ""),
  };
}

export async function pgListCourseReviews(
  courseId: string,
): Promise<EpisodeReviewRow[]> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT project_id, course_id, parts_checked, review_status, issues_found,
            correction_status, assignee_email, rendered_uploaded,
            updated_by_email, updated_at::text AS updated_at
       FROM episode_reviews WHERE course_id = $1`,
    [courseId],
  );
  return res.rows.map(rowToReview);
}

export async function pgUpsertReview(
  input: EpisodeReviewInput,
): Promise<EpisodeReviewRow> {
  const now = new Date().toISOString();
  const res = await pgQuery<Record<string, unknown>>(
    `INSERT INTO episode_reviews (
       project_id, course_id, parts_checked, review_status, issues_found,
       correction_status, assignee_email, rendered_uploaded,
       updated_by_email, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)
     ON CONFLICT (project_id) DO UPDATE SET
       course_id = EXCLUDED.course_id,
       parts_checked = EXCLUDED.parts_checked,
       review_status = EXCLUDED.review_status,
       issues_found = EXCLUDED.issues_found,
       correction_status = EXCLUDED.correction_status,
       assignee_email = EXCLUDED.assignee_email,
       rendered_uploaded = EXCLUDED.rendered_uploaded,
       updated_by_email = EXCLUDED.updated_by_email,
       updated_at = EXCLUDED.updated_at
     RETURNING project_id, course_id, parts_checked, review_status, issues_found,
       correction_status, assignee_email, rendered_uploaded,
       updated_by_email, updated_at::text AS updated_at`,
    [
      input.project_id,
      input.course_id ?? null,
      input.parts_checked ?? "",
      input.review_status ?? "",
      input.issues_found ?? "",
      input.correction_status ?? "",
      input.assignee_email ?? "",
      input.rendered_uploaded ?? "",
      input.updated_by_email ?? null,
      now,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error("Review save failed");
  return rowToReview(row);
}
