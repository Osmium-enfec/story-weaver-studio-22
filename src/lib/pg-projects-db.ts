import { randomUUID } from "node:crypto";
import {
  getProjectParts,
  mergePartsForCollaborativeSave,
} from "@/lib/project-parts";
import { pgQuery } from "@/lib/pg";
import {
  userCanAccessProject,
  type LocalAssignmentItem,
  type LocalProjectAdminItem,
  type LocalProjectListItem,
  type LocalProjectRow,
} from "@/lib/local-projects-db";

function parseJsonColumn(value: unknown): unknown {
  if (value == null) return [];
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return value;
}

function jsonForDb(value: unknown): string {
  if (typeof value === "string") {
    // Already serialized JSON text — validate by round-tripping when possible.
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify([]);
    }
  }
  return JSON.stringify(value ?? []);
}

function rowToProject(row: Record<string, unknown>): LocalProjectRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title),
    script: row.script != null ? String(row.script) : null,
    audio_mode: String(row.audio_mode ?? "tts"),
    scenes: parseJsonColumn(row.scenes),
    parts: parseJsonColumn(row.parts),
    thumbnail_url: row.thumbnail_url != null ? String(row.thumbnail_url) : null,
    course_id: row.course_id != null ? String(row.course_id) : null,
    assigned_user_id:
      row.assigned_user_id != null ? String(row.assigned_user_id) : null,
    assigned_user_email:
      row.assigned_user_email != null ? String(row.assigned_user_email) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function partAssigneeEmailsFromRaw(parts: unknown): string[] {
  const emails = new Set<string>();
  for (const p of getProjectParts({ parts })) {
    const email = p.assignedUserEmail?.trim();
    if (email) emails.add(email);
  }
  return [...emails].sort((a, b) => a.localeCompare(b));
}

function toListItem(row: Record<string, unknown>): LocalProjectListItem {
  const scenes = parseJsonColumn(row.scenes);
  const partsRaw = parseJsonColumn(row.parts);
  return {
    id: String(row.id),
    title: String(row.title),
    thumbnail_url: row.thumbnail_url != null ? String(row.thumbnail_url) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    audio_mode: String(row.audio_mode ?? "tts"),
    scene_count: Array.isArray(scenes) ? scenes.length : 0,
    part_count: Array.isArray(partsRaw) ? partsRaw.length : 0,
    course_id: row.course_id != null ? String(row.course_id) : null,
    assigned_user_id:
      row.assigned_user_id != null ? String(row.assigned_user_id) : null,
    assigned_user_email:
      row.assigned_user_email != null ? String(row.assigned_user_email) : null,
    part_assignee_emails: partAssigneeEmailsFromRaw(partsRaw),
  };
}

const PROJECT_SELECT = `
  id, user_id, title, script, audio_mode, scenes, parts, thumbnail_url, course_id,
  assigned_user_id, assigned_user_email,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

const LIST_SELECT = `
  id, title, thumbnail_url, created_at::text AS created_at, updated_at::text AS updated_at,
  audio_mode, scenes, parts, course_id, assigned_user_id, assigned_user_email, user_id
`;

export async function pgSaveProject(
  userId: string,
  userEmail: string,
  data: {
    id?: string;
    title: string;
    script?: string | null;
    audio_mode: string;
    scenes: unknown;
    parts?: unknown;
    thumbnail_url?: string | null;
    /** Pass explicitly to set/clear; omit to keep existing (or null on create). */
    course_id?: string | null;
    /** When true, missing scene ids on an editable part are treated as deletes. */
    allow_scene_shrink?: boolean;
  },
  opts?: { asAdmin?: boolean },
): Promise<string> {
  const now = new Date().toISOString();
  const id = data.id ?? randomUUID();
  const scenesJson = JSON.stringify(data.scenes ?? []);
  const asAdmin = opts?.asAdmin === true;

  const existingRes = await pgQuery<{
    id: string;
    user_id: string;
    parts: unknown;
    course_id: string | null;
    assigned_user_id: string | null;
    assigned_user_email: string | null;
  }>(
    `SELECT id, user_id, parts, course_id, assigned_user_id, assigned_user_email
     FROM projects WHERE id = $1`,
    [id],
  );
  const existing = existingRes.rows[0];

  if (existing) {
    const partsRaw = parseJsonColumn(existing.parts);
    const canWrite = userCanAccessProject(
      { userId, userEmail },
      {
        user_id: existing.user_id,
        assigned_user_id: existing.assigned_user_id ?? null,
        assigned_user_email: existing.assigned_user_email ?? null,
        parts: partsRaw,
      },
      { asAdmin },
    );
    if (!canWrite) {
      throw new Error("Not allowed to modify this project.");
    }
  }

  let partsJson: string;
  if (data.parts !== undefined) {
    if (existing) {
      const existingPartsRaw = parseJsonColumn(existing.parts);
      const merged = mergePartsForCollaborativeSave({
        existingParts: getProjectParts({ parts: existingPartsRaw }),
        incomingParts: data.parts,
        userId,
        userEmail,
        asAdmin,
        isOwner: existing.user_id === userId,
        now,
        allowSceneShrink: data.allow_scene_shrink === true,
      });
      partsJson = JSON.stringify(merged);
    } else {
      partsJson = JSON.stringify(data.parts);
    }
  } else if (existing?.parts != null) {
    partsJson = jsonForDb(existing.parts);
  } else {
    partsJson = "[]";
  }

  const courseId =
    data.course_id !== undefined
      ? data.course_id
      : existing?.course_id != null
        ? String(existing.course_id)
        : null;

  if (existing) {
    // Keep the original owner even when an admin saves.
    await pgQuery(
      `UPDATE projects SET
         title = $1, script = $2, audio_mode = $3,
         scenes = $4::jsonb, parts = $5::jsonb,
         thumbnail_url = $6, course_id = $7, updated_at = $8::timestamptz
       WHERE id = $9`,
      [
        data.title,
        data.script ?? null,
        data.audio_mode,
        scenesJson,
        partsJson,
        data.thumbnail_url ?? null,
        courseId,
        now,
        id,
      ],
    );
  } else {
    await pgQuery(
      `INSERT INTO projects (
         id, user_id, title, script, audio_mode, scenes, parts,
         thumbnail_url, course_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
         $8, $9, $10::timestamptz, $11::timestamptz
       )`,
      [
        id,
        userId,
        data.title,
        data.script ?? null,
        data.audio_mode,
        scenesJson,
        partsJson,
        data.thumbnail_url ?? null,
        courseId,
        now,
        now,
      ],
    );
  }
  return id;
}

export async function pgGetProject(
  userId: string,
  userEmail: string,
  id: string,
): Promise<LocalProjectRow | null> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT ${PROJECT_SELECT} FROM projects WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  const project = rowToProject(row);
  if (!userCanAccessProject({ userId, userEmail }, project)) return null;
  return project;
}

/** Admin / cross-user fetch — no owner filter. */
export async function pgGetProjectById(id: string): Promise<LocalProjectRow | null> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT ${PROJECT_SELECT} FROM projects WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  return row ? rowToProject(row) : null;
}

export async function pgListProjects(
  userId: string,
  userEmail: string,
  opts?: {
    courseId?: string | null;
    asAdmin?: boolean;
    /** When true, omit episodes with no course (non-admin default). */
    requireCourse?: boolean;
  },
): Promise<LocalProjectListItem[]> {
  let rows: Record<string, unknown>[];

  if (opts?.asAdmin) {
    if (opts && "courseId" in opts) {
      if (opts.courseId === null) {
        const res = await pgQuery<Record<string, unknown>>(
          `SELECT ${LIST_SELECT}
           FROM projects WHERE course_id IS NULL ORDER BY updated_at DESC`,
        );
        rows = res.rows;
      } else {
        const res = await pgQuery<Record<string, unknown>>(
          `SELECT ${LIST_SELECT}
           FROM projects WHERE course_id = $1 ORDER BY title ASC`,
          [opts.courseId],
        );
        rows = res.rows;
      }
    } else if (opts?.requireCourse) {
      const res = await pgQuery<Record<string, unknown>>(
        `SELECT ${LIST_SELECT}
         FROM projects WHERE course_id IS NOT NULL ORDER BY updated_at DESC`,
      );
      rows = res.rows;
    } else {
      const res = await pgQuery<Record<string, unknown>>(
        `SELECT ${LIST_SELECT} FROM projects ORDER BY updated_at DESC`,
      );
      rows = res.rows;
    }
    return rows.map(toListItem);
  }

  // Owner + part assignee (scan candidates, filter in memory) — same as sqlite.
  if (opts && "courseId" in opts) {
    if (opts.courseId === null) {
      // Unassigned episodes are admin-only; never list for non-admins.
      return [];
    }
    const res = await pgQuery<Record<string, unknown>>(
      `SELECT ${LIST_SELECT}
       FROM projects WHERE course_id = $1 ORDER BY title ASC`,
      [opts.courseId],
    );
    rows = res.rows;
  } else {
    // Non-admins never browse unassigned episodes.
    const res = await pgQuery<Record<string, unknown>>(
      `SELECT ${LIST_SELECT}
       FROM projects WHERE course_id IS NOT NULL ORDER BY updated_at DESC`,
    );
    rows = res.rows;
  }

  return rows
    .filter((row) =>
      userCanAccessProject(
        { userId, userEmail },
        {
          user_id: String(row.user_id),
          assigned_user_id:
            row.assigned_user_id != null ? String(row.assigned_user_id) : null,
          assigned_user_email:
            row.assigned_user_email != null
              ? String(row.assigned_user_email)
              : null,
          parts: parseJsonColumn(row.parts),
        },
      ),
    )
    .map(toListItem);
}

/** Admin-only: set / clear episode-level assignee. */
export async function pgAssignEpisode(
  episodeId: string,
  assignee: { userId: string; email: string } | null,
): Promise<LocalProjectRow> {
  const existing = await pgQuery<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1`,
    [episodeId],
  );
  if (!existing.rows[0]) throw new Error("Episode not found.");
  const now = new Date().toISOString();
  await pgQuery(
    `UPDATE projects SET assigned_user_id = $1, assigned_user_email = $2,
       updated_at = $3::timestamptz WHERE id = $4`,
    [assignee?.userId ?? null, assignee?.email ?? null, now, episodeId],
  );
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT ${PROJECT_SELECT} FROM projects WHERE id = $1`,
    [episodeId],
  );
  return rowToProject(res.rows[0]);
}

/** Admin-only: set / clear part-level assignee inside episode parts JSON. */
export async function pgAssignPart(
  episodeId: string,
  partId: string,
  assignee: { userId: string; email: string } | null,
): Promise<LocalProjectRow> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT ${PROJECT_SELECT} FROM projects WHERE id = $1`,
    [episodeId],
  );
  const row = res.rows[0];
  if (!row) throw new Error("Episode not found.");
  const project = rowToProject(row);
  const parts = getProjectParts(project);
  const idx = parts.findIndex((p) => p.id === partId);
  if (idx < 0) throw new Error("Part not found.");
  const now = new Date().toISOString();
  parts[idx] = {
    ...parts[idx],
    assignedUserId: assignee?.userId ?? null,
    assignedUserEmail: assignee?.email ?? null,
    updated_at: now,
  };
  await pgQuery(
    `UPDATE projects SET parts = $1::jsonb, updated_at = $2::timestamptz WHERE id = $3`,
    [JSON.stringify(parts), now, episodeId],
  );
  return { ...project, parts, updated_at: now };
}

/** Course IDs the user can open via episode/part assignment (not ownership). */
export async function pgAssignedCourseIds(
  userId: string,
  userEmail: string,
): Promise<string[]> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT course_id, user_id, assigned_user_id, assigned_user_email, parts
     FROM projects WHERE course_id IS NOT NULL`,
  );
  const ids = new Set<string>();
  for (const row of res.rows) {
    const courseId = row.course_id != null ? String(row.course_id) : null;
    if (!courseId) continue;
    if (String(row.user_id) === userId) continue; // owned courses listed separately
    if (
      userCanAccessProject(
        { userId, userEmail },
        {
          user_id: String(row.user_id),
          assigned_user_id:
            row.assigned_user_id != null ? String(row.assigned_user_id) : null,
          assigned_user_email:
            row.assigned_user_email != null
              ? String(row.assigned_user_email)
              : null,
          parts: parseJsonColumn(row.parts),
        },
      )
    ) {
      ids.add(courseId);
    }
  }
  return [...ids];
}

/** Admin: total saved compose scenes per assignee across all parts. */
export async function pgSavedSceneCountsByUser(): Promise<Map<string, number>> {
  const res = await pgQuery<{ parts: unknown }>(
    `SELECT parts FROM projects WHERE parts::text LIKE '%"assignedUserId"%'`,
  );
  const byUser = new Map<string, number>();
  for (const row of res.rows) {
    const partsRaw = parseJsonColumn(row.parts);
    for (const part of getProjectParts({ parts: partsRaw })) {
      if (!part.assignedUserId) continue;
      const n = Array.isArray(part.scenes) ? part.scenes.length : 0;
      byUser.set(
        part.assignedUserId,
        (byUser.get(part.assignedUserId) ?? 0) + n,
      );
    }
  }
  return byUser;
}

/** Admin: episode + part handoffs currently assigned to a collaborator. */
export async function pgListAssignments(): Promise<LocalAssignmentItem[]> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT id, title, course_id, assigned_user_id, assigned_user_email, parts,
            updated_at::text AS updated_at
     FROM projects
     WHERE assigned_user_id IS NOT NULL
        OR parts::text LIKE '%"assignedUserId"%'
     ORDER BY updated_at DESC`,
  );

  const out: LocalAssignmentItem[] = [];
  for (const row of res.rows) {
    const episodeId = String(row.id);
    const episodeTitle = String(row.title);
    const courseId = row.course_id != null ? String(row.course_id) : null;
    const updated_at = String(row.updated_at);
    if (row.assigned_user_id) {
      out.push({
        kind: "episode",
        episodeId,
        episodeTitle,
        courseId,
        assignedUserId: String(row.assigned_user_id),
        assignedUserEmail: String(row.assigned_user_email ?? ""),
        updated_at,
      });
    }
    const partsRaw = parseJsonColumn(row.parts);
    for (const part of getProjectParts({ parts: partsRaw })) {
      if (!part.assignedUserId) continue;
      out.push({
        kind: "part",
        episodeId,
        episodeTitle,
        courseId,
        partId: part.id,
        partTitle: part.title,
        assignedUserId: part.assignedUserId,
        assignedUserEmail: part.assignedUserEmail?.trim() || "",
        sceneCount: Array.isArray(part.scenes) ? part.scenes.length : 0,
        updated_at: part.updated_at || updated_at,
      });
    }
  }
  return out;
}

/** Clear episode/part assignees that point at this user (used when deleting an account). */
export async function pgClearAssignmentsForUser(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await pgQuery(
    `UPDATE projects SET assigned_user_id = NULL, assigned_user_email = NULL,
       updated_at = $1::timestamptz
     WHERE assigned_user_id = $2`,
    [now, userId],
  );

  const res = await pgQuery<{ id: string; parts: unknown }>(
    `SELECT id, parts FROM projects WHERE parts::text LIKE '%"assignedUserId"%'`,
  );
  for (const row of res.rows) {
    const partsRaw = parseJsonColumn(row.parts);
    const parts = getProjectParts({ parts: partsRaw });
    let changed = false;
    const next = parts.map((p) => {
      if (p.assignedUserId !== userId) return p;
      changed = true;
      return {
        ...p,
        assignedUserId: null,
        assignedUserEmail: null,
        updated_at: now,
      };
    });
    if (changed) {
      await pgQuery(
        `UPDATE projects SET parts = $1::jsonb, updated_at = $2::timestamptz WHERE id = $3`,
        [JSON.stringify(next), now, row.id],
      );
    }
  }
}

/** Admin: every project, newest first. */
export async function pgListAllProjects(): Promise<LocalProjectAdminItem[]> {
  const res = await pgQuery<Record<string, unknown>>(
    `SELECT id, user_id, title, thumbnail_url,
            created_at::text AS created_at, updated_at::text AS updated_at,
            audio_mode, scenes, parts, course_id,
            assigned_user_id, assigned_user_email
     FROM projects ORDER BY updated_at DESC`,
  );

  return res.rows.map((row) => ({
    ...toListItem(row),
    user_id: String(row.user_id),
  }));
}

export async function pgDeleteProject(_userId: string, _id: string): Promise<void> {
  throw new Error(
    "Project deletion is disabled. All projects are kept on the host machine.",
  );
}
