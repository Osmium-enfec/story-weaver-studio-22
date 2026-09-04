import path from "node:path";
import { hostProjectsDbPath } from "@/lib/host-storage";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { usePostgres } from "@/lib/runtime-backends";

/**
 * Per-part review sheet (shared across all signed-in users).
 * One row per episode part; lives in the same SQLite file as projects/courses
 * locally, and in the Postgres `part_reviews` table on hosted deploys.
 */
export interface PartReviewRow {
  project_id: string;
  part_id: string;
  course_id: string | null;
  script_status: string;
  recording_status: string;
  review_status: string;
  issues_found: string;
  correction_status: string;
  assignee_email: string;
  review_doc_url: string;
  review_doc_name: string;
  rendered_uploaded: string;
  updated_by_email: string | null;
  updated_at: string;
}

export interface PartReviewInput {
  project_id: string;
  part_id: string;
  course_id?: string | null;
  script_status?: string;
  recording_status?: string;
  review_status?: string;
  issues_found?: string;
  correction_status?: string;
  assignee_email?: string;
  review_doc_url?: string;
  review_doc_name?: string;
  rendered_uploaded?: string;
  updated_by_email?: string | null;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const file = hostProjectsDbPath();
  mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS part_reviews (
      project_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      course_id TEXT,
      script_status TEXT NOT NULL DEFAULT '',
      recording_status TEXT NOT NULL DEFAULT '',
      review_status TEXT NOT NULL DEFAULT '',
      issues_found TEXT NOT NULL DEFAULT '',
      correction_status TEXT NOT NULL DEFAULT '',
      assignee_email TEXT NOT NULL DEFAULT '',
      review_doc_url TEXT NOT NULL DEFAULT '',
      review_doc_name TEXT NOT NULL DEFAULT '',
      rendered_uploaded TEXT NOT NULL DEFAULT '',
      updated_by_email TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, part_id)
    );
    CREATE INDEX IF NOT EXISTS part_reviews_course_idx
      ON part_reviews (course_id);
  `);
  for (const col of ["review_doc_url", "review_doc_name"]) {
    try {
      db.exec(
        `ALTER TABLE part_reviews ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`,
      );
    } catch {
      /* column already exists */
    }
  }
  return db;
}

export function rowToPartReview(row: Record<string, unknown>): PartReviewRow {
  return {
    project_id: String(row.project_id),
    part_id: String(row.part_id),
    course_id: row.course_id != null ? String(row.course_id) : null,
    script_status: String(row.script_status ?? ""),
    recording_status: String(row.recording_status ?? ""),
    review_status: String(row.review_status ?? ""),
    issues_found: String(row.issues_found ?? ""),
    correction_status: String(row.correction_status ?? ""),
    assignee_email: String(row.assignee_email ?? ""),
    review_doc_url: String(row.review_doc_url ?? ""),
    review_doc_name: String(row.review_doc_name ?? ""),
    rendered_uploaded: String(row.rendered_uploaded ?? ""),
    updated_by_email:
      row.updated_by_email != null ? String(row.updated_by_email) : null,
    updated_at: String(row.updated_at ?? ""),
  };
}

function sqliteListCourseReviews(courseId: string): PartReviewRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM part_reviews WHERE course_id = ?`)
    .all(courseId) as Record<string, unknown>[];
  return rows.map(rowToPartReview);
}

function sqliteUpsertReview(input: PartReviewInput): PartReviewRow {
  const conn = getDb();
  const now = new Date().toISOString();
  const existing = conn
    .prepare(`SELECT * FROM part_reviews WHERE project_id = ? AND part_id = ?`)
    .get(input.project_id, input.part_id) as Record<string, unknown> | undefined;
  const base = existing
    ? rowToPartReview(existing)
    : {
        script_status: "",
        recording_status: "",
        review_status: "",
        issues_found: "",
        correction_status: "",
        assignee_email: "",
        review_doc_url: "",
        review_doc_name: "",
        rendered_uploaded: "",
      };
  const merged = {
    script_status: input.script_status ?? base.script_status,
    recording_status: input.recording_status ?? base.recording_status,
    review_status: input.review_status ?? base.review_status,
    issues_found: input.issues_found ?? base.issues_found,
    correction_status: input.correction_status ?? base.correction_status,
    assignee_email: input.assignee_email ?? base.assignee_email,
    review_doc_url: input.review_doc_url ?? base.review_doc_url,
    review_doc_name: input.review_doc_name ?? base.review_doc_name,
    rendered_uploaded: input.rendered_uploaded ?? base.rendered_uploaded,
  };
  conn
    .prepare(
      `INSERT INTO part_reviews (
         project_id, part_id, course_id, script_status, recording_status,
         review_status, issues_found, correction_status, assignee_email,
         review_doc_url, review_doc_name,
         rendered_uploaded, updated_by_email, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (project_id, part_id) DO UPDATE SET
         course_id = excluded.course_id,
         script_status = excluded.script_status,
         recording_status = excluded.recording_status,
         review_status = excluded.review_status,
         issues_found = excluded.issues_found,
         correction_status = excluded.correction_status,
         assignee_email = excluded.assignee_email,
         review_doc_url = excluded.review_doc_url,
         review_doc_name = excluded.review_doc_name,
         rendered_uploaded = excluded.rendered_uploaded,
         updated_by_email = excluded.updated_by_email,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.project_id,
      input.part_id,
      input.course_id ?? null,
      merged.script_status,
      merged.recording_status,
      merged.review_status,
      merged.issues_found,
      merged.correction_status,
      merged.assignee_email,
      merged.review_doc_url,
      merged.review_doc_name,
      merged.rendered_uploaded,
      input.updated_by_email ?? null,
      now,
    );
  const row = conn
    .prepare(`SELECT * FROM part_reviews WHERE project_id = ? AND part_id = ?`)
    .get(input.project_id, input.part_id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Review save failed");
  return rowToPartReview(row);
}

function partAssigneeFromRawParts(parts: unknown, partId: string): string | null {
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const rec = p as Record<string, unknown>;
    if (String(rec.id ?? "") !== partId) continue;
    const email = rec.assignedUserEmail ?? rec.assigned_user_email;
    return email ? String(email) : null;
  }
  return null;
}

function sqlitePartAssignee(projectId: string, partId: string): string | null {
  const row = getDb()
    .prepare(`SELECT parts FROM projects WHERE id = ?`)
    .get(projectId) as { parts?: string } | undefined;
  if (!row) return null;
  try {
    return partAssigneeFromRawParts(JSON.parse(row.parts ?? "[]"), partId);
  } catch {
    return null;
  }
}

// --- Dual backend ---

export async function listCourseReviews(
  courseId: string,
): Promise<PartReviewRow[]> {
  if (usePostgres()) {
    const { pgListCourseReviews } = await import("@/lib/pg-review-db");
    return pgListCourseReviews(courseId);
  }
  return sqliteListCourseReviews(courseId);
}

export async function upsertReview(
  input: PartReviewInput,
): Promise<PartReviewRow> {
  if (usePostgres()) {
    const { pgUpsertReview } = await import("@/lib/pg-review-db");
    return pgUpsertReview(input);
  }
  return sqliteUpsertReview(input);
}

/** Single review row (cheap lookup used by the permission check on save). */
export async function getReview(
  projectId: string,
  partId: string,
): Promise<PartReviewRow | null> {
  if (usePostgres()) {
    const { pgGetReview } = await import("@/lib/pg-review-db");
    return pgGetReview(projectId, partId);
  }
  const row = getDb()
    .prepare(`SELECT * FROM part_reviews WHERE project_id = ? AND part_id = ?`)
    .get(projectId, partId) as Record<string, unknown> | undefined;
  return row ? rowToPartReview(row) : null;
}

/** Email of the user this part is assigned to for composing (or null). */
export async function partComposerEmail(
  projectId: string,
  partId: string,
): Promise<string | null> {
  if (usePostgres()) {
    const { pgPartComposerEmail } = await import("@/lib/pg-review-db");
    return pgPartComposerEmail(projectId, partId);
  }
  return sqlitePartAssignee(projectId, partId);
}

export { partAssigneeFromRawParts };
