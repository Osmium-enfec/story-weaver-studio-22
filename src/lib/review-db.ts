import path from "node:path";
import { hostProjectsDbPath } from "@/lib/host-storage";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { usePostgres } from "@/lib/runtime-backends";

/**
 * Episode review sheet (shared across all signed-in users).
 * One row per episode; lives in the same SQLite file as projects/courses
 * locally, and in the Postgres `episode_reviews` table on hosted deploys.
 */
export interface EpisodeReviewRow {
  project_id: string;
  course_id: string | null;
  parts_checked: string;
  review_status: string;
  issues_found: string;
  correction_status: string;
  assignee_email: string;
  rendered_uploaded: string;
  updated_by_email: string | null;
  updated_at: string;
}

export interface EpisodeReviewInput {
  project_id: string;
  course_id?: string | null;
  parts_checked?: string;
  review_status?: string;
  issues_found?: string;
  correction_status?: string;
  assignee_email?: string;
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
    CREATE TABLE IF NOT EXISTS episode_reviews (
      project_id TEXT PRIMARY KEY,
      course_id TEXT,
      parts_checked TEXT NOT NULL DEFAULT '',
      review_status TEXT NOT NULL DEFAULT '',
      issues_found TEXT NOT NULL DEFAULT '',
      correction_status TEXT NOT NULL DEFAULT '',
      assignee_email TEXT NOT NULL DEFAULT '',
      rendered_uploaded TEXT NOT NULL DEFAULT '',
      updated_by_email TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS episode_reviews_course_idx
      ON episode_reviews (course_id);
  `);
  return db;
}

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

function sqliteListCourseReviews(courseId: string): EpisodeReviewRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM episode_reviews WHERE course_id = ?`)
    .all(courseId) as Record<string, unknown>[];
  return rows.map(rowToReview);
}

function sqliteUpsertReview(input: EpisodeReviewInput): EpisodeReviewRow {
  const conn = getDb();
  const now = new Date().toISOString();
  conn
    .prepare(
      `INSERT INTO episode_reviews (
         project_id, course_id, parts_checked, review_status, issues_found,
         correction_status, assignee_email, rendered_uploaded,
         updated_by_email, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (project_id) DO UPDATE SET
         course_id = excluded.course_id,
         parts_checked = excluded.parts_checked,
         review_status = excluded.review_status,
         issues_found = excluded.issues_found,
         correction_status = excluded.correction_status,
         assignee_email = excluded.assignee_email,
         rendered_uploaded = excluded.rendered_uploaded,
         updated_by_email = excluded.updated_by_email,
         updated_at = excluded.updated_at`,
    )
    .run(
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
    );
  const row = conn
    .prepare(`SELECT * FROM episode_reviews WHERE project_id = ?`)
    .get(input.project_id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Review save failed");
  return rowToReview(row);
}

// --- Dual backend ---

export async function listCourseReviews(
  courseId: string,
): Promise<EpisodeReviewRow[]> {
  if (usePostgres()) {
    const { pgListCourseReviews } = await import("@/lib/pg-review-db");
    return pgListCourseReviews(courseId);
  }
  return sqliteListCourseReviews(courseId);
}

export async function upsertReview(
  input: EpisodeReviewInput,
): Promise<EpisodeReviewRow> {
  if (usePostgres()) {
    const { pgUpsertReview } = await import("@/lib/pg-review-db");
    return pgUpsertReview(input);
  }
  return sqliteUpsertReview(input);
}
