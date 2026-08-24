import path from "node:path";
import { hostProjectsDbPath } from "@/lib/host-storage";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { usePostgres } from "@/lib/runtime-backends";

/**
 * Courses share the same SQLite file as projects (episodes).
 * Opening getDb() also ensures projects.course_id exists.
 */
export interface LocalCourseRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalCourseListItem {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
  episode_count: number;
}

let db: Database.Database | null = null;

function dbPath(): string {
  return hostProjectsDbPath();
}

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(dbPath()), { recursive: true });
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      thumbnail_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS courses_user_updated_idx
      ON courses (user_id, updated_at DESC);
  `);
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN course_id TEXT`);
  } catch {
    /* column exists */
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS projects_user_course_idx ON projects (user_id, course_id)`,
    );
  } catch {
    /* index exists */
  }
  return db;
}

function rowToCourse(row: Record<string, unknown>): LocalCourseRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title),
    description: row.description != null ? String(row.description) : null,
    thumbnail_url: row.thumbnail_url != null ? String(row.thumbnail_url) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function sqliteSaveCourse(
  userId: string,
  data: {
    id?: string;
    title: string;
    description?: string | null;
    thumbnail_url?: string | null;
  },
  opts?: { asAdmin?: boolean },
): string {
  const conn = getDb();
  const now = new Date().toISOString();
  const id = data.id ?? randomUUID();

  const existing = conn
    .prepare("SELECT id, user_id FROM courses WHERE id = ?")
    .get(id) as { id: string; user_id: string } | undefined;

  if (!existing && opts?.asAdmin !== true) {
    throw new Error("Not allowed to create courses. Only admins can create courses.");
  }

  if (existing && existing.user_id !== userId && opts?.asAdmin !== true) {
    throw new Error("Not allowed to modify this course.");
  }

  if (existing) {
    conn
      .prepare(
        `UPDATE courses SET title = ?, description = ?, thumbnail_url = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        data.title,
        data.description ?? null,
        data.thumbnail_url ?? null,
        now,
        id,
      );
  } else {
    conn
      .prepare(
        `INSERT INTO courses (id, user_id, title, description, thumbnail_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        data.title,
        data.description ?? null,
        data.thumbnail_url ?? null,
        now,
        now,
      );
  }
  return id;
}

async function sqliteGetCourse(
  userId: string,
  userEmail: string,
  id: string,
): Promise<LocalCourseRow | null> {
  const row = getDb()
    .prepare("SELECT * FROM courses WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  void userId;
  void userEmail;
  // Shared catalog: any signed-in user can open any course.
  return rowToCourse(row);
}

function sqliteGetCourseById(id: string): LocalCourseRow | null {
  const row = getDb()
    .prepare("SELECT * FROM courses WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToCourse(row) : null;
}

async function sqliteListCourses(
  userId: string,
  userEmail: string,
  opts?: { asAdmin?: boolean },
): Promise<LocalCourseListItem[]> {
  void userId;
  void userEmail;
  void opts;
  const conn = getDb();
  // Shared catalog: all courses are visible to every signed-in user.
  const rows = conn
    .prepare(
      `SELECT id, title, description, thumbnail_url, created_at, updated_at, user_id
       FROM courses ORDER BY updated_at DESC`,
    )
    .all() as Record<string, unknown>[];

  const countStmt = conn.prepare(
    `SELECT COUNT(*) AS n FROM projects WHERE course_id = ?`,
  );

  return rows.map((row) => {
    const countRow = countStmt.get(String(row.id)) as { n: number };
    return {
      id: String(row.id),
      title: String(row.title),
      description: row.description != null ? String(row.description) : null,
      thumbnail_url: row.thumbnail_url != null ? String(row.thumbnail_url) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      episode_count: Number(countRow?.n ?? 0),
    };
  });
}

/** Ensure courses schema + projects.course_id migration run (side effect). */
export function ensureCoursesSchema(): void {
  getDb();
}

export interface LocalCourseAdminItem extends LocalCourseListItem {
  user_id: string;
}

/** Admin: every course, newest first. */
function sqliteListAllCourses(): LocalCourseAdminItem[] {
  const conn = getDb();
  const rows = conn
    .prepare(
      `SELECT id, user_id, title, description, thumbnail_url, created_at, updated_at
       FROM courses ORDER BY updated_at DESC`,
    )
    .all() as Record<string, unknown>[];
  const countStmt = conn.prepare(
    `SELECT COUNT(*) AS n FROM projects WHERE course_id = ?`,
  );
  return rows.map((row) => {
    const countRow = countStmt.get(String(row.id)) as { n: number };
    return {
      id: String(row.id),
      user_id: String(row.user_id),
      title: String(row.title),
      description: row.description != null ? String(row.description) : null,
      thumbnail_url: row.thumbnail_url != null ? String(row.thumbnail_url) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      episode_count: Number(countRow?.n ?? 0),
    };
  });
}

/** Cheap episode counts per owner (no JSON parse). */
function sqliteEpisodeCountByUser(): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT user_id, COUNT(*) AS n FROM projects GROUP BY user_id`)
    .all() as { user_id: string; n: number }[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(String(r.user_id), Number(r.n ?? 0));
  return map;
}

function sqliteCourseCountByUser(): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT user_id, COUNT(*) AS n FROM courses GROUP BY user_id`)
    .all() as { user_id: string; n: number }[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(String(r.user_id), Number(r.n ?? 0));
  return map;
}

function sqliteEpisodeTotalCount(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM projects`).get() as {
    n: number;
  };
  return Number(row?.n ?? 0);
}

// --- Dual backend ---

export async function localSaveCourse(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgSaveCourse } = await import("@/lib/pg-courses-db");
    return pgSaveCourse(...(args as [any, any, any?]));
  }
  return sqliteSaveCourse(...(args as [any, any, any?]));
}

export async function localGetCourse(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgGetCourse } = await import("@/lib/pg-courses-db");
    return pgGetCourse(...(args as [any, any, any]));
  }
  return sqliteGetCourse(...(args as [any, any, any]));
}

export async function localGetCourseById(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgGetCourseById } = await import("@/lib/pg-courses-db");
    return pgGetCourseById(...(args as [any]));
  }
  return sqliteGetCourseById(...(args as [any]));
}

export async function localListCourses(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgListCourses } = await import("@/lib/pg-courses-db");
    return pgListCourses(...(args as [any, any, any?]));
  }
  return sqliteListCourses(...(args as [any, any, any?]));
}

export async function localListAllCourses(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgListAllCourses } = await import("@/lib/pg-courses-db");
    return pgListAllCourses();
  }
  return sqliteListAllCourses();
}

export async function localEpisodeCountByUser(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgEpisodeCountByUser } = await import("@/lib/pg-courses-db");
    return pgEpisodeCountByUser();
  }
  return sqliteEpisodeCountByUser();
}

export async function localCourseCountByUser(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgCourseCountByUser } = await import("@/lib/pg-courses-db");
    return pgCourseCountByUser();
  }
  return sqliteCourseCountByUser();
}

export async function localEpisodeTotalCount(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgEpisodeTotalCount } = await import("@/lib/pg-courses-db");
    return pgEpisodeTotalCount();
  }
  return sqliteEpisodeTotalCount();
}

/** Upsert a course row from an admin assignment snapshot. */
function sqliteApplySyncedCourse(course: Record<string, any>): void {
  const conn = getDb();
  const id = String(course?.id ?? "");
  if (!id) throw new Error("Course id required.");
  const now = new Date().toISOString();
  const exists = conn.prepare("SELECT id FROM courses WHERE id = ?").get(id) as
    | { id: string }
    | undefined;

  if (exists) {
    conn
      .prepare(
        `UPDATE courses SET title = ?, description = ?, thumbnail_url = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        String(course.title ?? "Untitled"),
        course.description ?? null,
        course.thumbnail_url ?? null,
        now,
        id,
      );
    return;
  }

  conn
    .prepare(
      `INSERT INTO courses (id, user_id, title, description, thumbnail_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      String(course.user_id ?? ""),
      String(course.title ?? "Untitled"),
      course.description ?? null,
      course.thumbnail_url ?? null,
      String(course.created_at ?? now),
      now,
    );
}

export async function applySyncedCourse(...args: any[]): Promise<any> {
  if (usePostgres()) {
    throw new Error("Assignment sync is only supported on local SQLite (desktop / LAN Mac).");
  }
  return sqliteApplySyncedCourse(...(args as [any]));
}
