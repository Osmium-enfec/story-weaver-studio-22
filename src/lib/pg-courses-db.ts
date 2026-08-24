import { randomUUID } from "node:crypto";
import { pgQuery } from "@/lib/pg";
import type {
  LocalCourseAdminItem,
  LocalCourseListItem,
  LocalCourseRow,
} from "@/lib/local-courses-db";

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

const COURSE_SELECT = `
  id, user_id, title, description, thumbnail_url,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

export async function pgSaveCourse(
  userId: string,
  data: {
    id?: string;
    title: string;
    description?: string | null;
    thumbnail_url?: string | null;
  },
  opts?: { asAdmin?: boolean },
): Promise<string> {
  const now = new Date().toISOString();
  const id = data.id ?? randomUUID();

  const existingRes = await pgQuery<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM courses WHERE id = $1`,
    [id],
  );
  const existing = existingRes.rows[0];

  if (!existing && opts?.asAdmin !== true) {
    throw new Error("Not allowed to create courses. Only admins can create courses.");
  }

  if (existing && existing.user_id !== userId && opts?.asAdmin !== true) {
    throw new Error("Not allowed to modify this course.");
  }

  if (existing) {
    await pgQuery(
      `UPDATE courses SET title = $1, description = $2, thumbnail_url = $3,
         updated_at = $4::timestamptz
       WHERE id = $5`,
      [
        data.title,
        data.description ?? null,
        data.thumbnail_url ?? null,
        now,
        id,
      ],
    );
  } else {
    await pgQuery(
      `INSERT INTO courses (id, user_id, title, description, thumbnail_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
      [
        id,
        userId,
        data.title,
        data.description ?? null,
        data.thumbnail_url ?? null,
        now,
        now,
      ],
    );
  }
  return id;
}

export async function pgGetCourse(
  userId: string,
  userEmail: string,
  id: string,
): Promise<LocalCourseRow | null> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT ${COURSE_SELECT} FROM courses WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  // Shared catalog: every signed-in user can open any course (read-only unless
  // they own it, are assigned a part, or are an admin — writes are guarded separately).
  void userId;
  void userEmail;
  return rowToCourse(row);
}

export async function pgGetCourseById(id: string): Promise<LocalCourseRow | null> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT ${COURSE_SELECT} FROM courses WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  return row ? rowToCourse(row) : null;
}

export async function pgListCourses(
  userId: string,
  userEmail: string,
  opts?: { asAdmin?: boolean },
): Promise<LocalCourseListItem[]> {
  void userId;
  void userEmail;
  void opts;
  // Shared catalog: all courses are visible to every signed-in user.
  const allRes = await pgQuery<Record<string, unknown>>(
    `SELECT id, title, description, thumbnail_url,
            created_at::text AS created_at, updated_at::text AS updated_at, user_id
     FROM courses ORDER BY updated_at DESC`,
  );
  const rows = allRes.rows;

  return Promise.all(
    rows.map(async (row) => {
      const countRes = await pgQuery<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM projects WHERE course_id = $1`,
        [String(row.id)],
      );
      return {
        id: String(row.id),
        title: String(row.title),
        description: row.description != null ? String(row.description) : null,
        thumbnail_url:
          row.thumbnail_url != null ? String(row.thumbnail_url) : null,
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        episode_count: Number(countRes.rows[0]?.n ?? 0),
      };
    }),
  );
}

/** Admin: every course, newest first. */
export async function pgListAllCourses(): Promise<LocalCourseAdminItem[]> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT id, user_id, title, description, thumbnail_url,
            created_at::text AS created_at, updated_at::text AS updated_at
     FROM courses ORDER BY updated_at DESC`,
  );

  return Promise.all(
    res.rows.map(async (row) => {
      const countRes = await pgQuery<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM projects WHERE course_id = $1`,
        [String(row.id)],
      );
      return {
        id: String(row.id),
        user_id: String(row.user_id),
        title: String(row.title),
        description: row.description != null ? String(row.description) : null,
        thumbnail_url:
          row.thumbnail_url != null ? String(row.thumbnail_url) : null,
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        episode_count: Number(countRes.rows[0]?.n ?? 0),
      };
    }),
  );
}

/** Cheap episode counts per owner (no JSON parse). */
export async function pgEpisodeCountByUser(): Promise<Map<string, number>> {
  const res = await pgQuery<{ user_id: string; n: string }>(
    `SELECT user_id, COUNT(*)::text AS n FROM projects GROUP BY user_id`,
  );
  const map = new Map<string, number>();
  for (const r of res.rows) map.set(String(r.user_id), Number(r.n ?? 0));
  return map;
}

export async function pgCourseCountByUser(): Promise<Map<string, number>> {
  const res = await pgQuery<{ user_id: string; n: string }>(
    `SELECT user_id, COUNT(*)::text AS n FROM courses GROUP BY user_id`,
  );
  const map = new Map<string, number>();
  for (const r of res.rows) map.set(String(r.user_id), Number(r.n ?? 0));
  return map;
}

export async function pgEpisodeTotalCount(): Promise<number> {
  const res = await pgQuery<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM projects`,
  );
  return Number(res.rows[0]?.n ?? 0);
}
