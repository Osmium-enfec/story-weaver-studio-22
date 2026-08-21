import path from "node:path";
import { hostProjectsDbPath } from "@/lib/host-storage";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  getProjectParts,
  mergePartsForCollaborativeSave,
} from "@/lib/project-parts";
import { usePostgres } from "@/lib/runtime-backends";

/** SQLite row for an episode (legacy table name: projects). */
export interface LocalProjectRow {
  id: string;
  user_id: string;
  title: string;
  script: string | null;
  audio_mode: string;
  scenes: unknown;
  parts?: unknown;
  thumbnail_url: string | null;
  /** Parent course; null = episode not assigned to any course. */
  course_id: string | null;
  /** Collaborator assigned to the whole episode (admin handoff). */
  assigned_user_id: string | null;
  assigned_user_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalProjectListItem {
  id: string;
  title: string;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
  audio_mode: string;
  scene_count: number;
  part_count: number;
  course_id: string | null;
  assigned_user_id: string | null;
  assigned_user_email: string | null;
  /** Unique emails from part-level assignments. */
  part_assignee_emails: string[];
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
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      script TEXT,
      audio_mode TEXT NOT NULL DEFAULT 'tts',
      scenes TEXT NOT NULL DEFAULT '[]',
      thumbnail_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_user_updated_idx
      ON projects (user_id, updated_at DESC);
  `);
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN parts TEXT NOT NULL DEFAULT '[]'`);
  } catch {
    /* column exists */
  }
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
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN assigned_user_id TEXT`);
  } catch {
    /* column exists */
  }
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN assigned_user_email TEXT`);
  } catch {
    /* column exists */
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS projects_assigned_user_idx ON projects (assigned_user_id)`,
    );
  } catch {
    /* index exists */
  }
  return db;
}

function rowToProject(row: Record<string, unknown>): LocalProjectRow {
  let scenes: unknown = [];
  try {
    scenes = JSON.parse(String(row.scenes ?? "[]"));
  } catch {
    scenes = [];
  }
  let parts: unknown = [];
  try {
    parts = JSON.parse(String(row.parts ?? "[]"));
  } catch {
    parts = [];
  }
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title),
    script: row.script != null ? String(row.script) : null,
    audio_mode: String(row.audio_mode ?? "tts"),
    scenes,
    parts,
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

function partsAssignUserId(parts: unknown, userId: string): boolean {
  return getProjectParts({ parts }).some((p) => p.assignedUserId === userId);
}

function partsAssignUserEmail(parts: unknown, userEmail: string): boolean {
  const normalized = userEmail.trim().toLowerCase();
  return getProjectParts({ parts }).some((p) => p.assignedUserEmail?.trim().toLowerCase() === normalized);
}

/** Owner, admin, or any part assignee. Episode-wide assignment is intentionally ignored. */
export function userCanAccessProject(
  user: { userId: string; userEmail: string },
  project: Pick<
    LocalProjectRow,
    "user_id" | "assigned_user_id" | "assigned_user_email" | "parts"
  >,
  opts?: { asAdmin?: boolean },
): boolean {
  if (opts?.asAdmin) return true;
  if (project.user_id === user.userId) return true;
  if (partsAssignUserId(project.parts, user.userId)) return true;
  if (partsAssignUserEmail(project.parts, user.userEmail)) return true;
  return false;
}

function toListItem(row: Record<string, unknown>): LocalProjectListItem {
  let sceneCount = 0;
  let partCount = 0;
  let partsRaw: unknown = [];
  try {
    const parsed = JSON.parse(String(row.scenes ?? "[]"));
    sceneCount = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    sceneCount = 0;
  }
  try {
    partsRaw = JSON.parse(String(row.parts ?? "[]"));
    partCount = Array.isArray(partsRaw) ? partsRaw.length : 0;
  } catch {
    partsRaw = [];
    partCount = 0;
  }
  return {
    id: String(row.id),
    title: String(row.title),
    thumbnail_url: row.thumbnail_url != null ? String(row.thumbnail_url) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    audio_mode: String(row.audio_mode ?? "tts"),
    scene_count: sceneCount,
    part_count: partCount,
    course_id: row.course_id != null ? String(row.course_id) : null,
    assigned_user_id:
      row.assigned_user_id != null ? String(row.assigned_user_id) : null,
    assigned_user_email:
      row.assigned_user_email != null ? String(row.assigned_user_email) : null,
    part_assignee_emails: partAssigneeEmailsFromRaw(partsRaw),
  };
}

function sqliteSaveProject(
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
): string {
  const conn = getDb();
  const now = new Date().toISOString();
  const id = data.id ?? randomUUID();
  const scenesJson = JSON.stringify(data.scenes ?? []);
  const asAdmin = opts?.asAdmin === true;

  // Lookup by id only — admin may update another user's project without
  // hitting UNIQUE(id) by accidentally INSERTing a duplicate row.
  const existing = conn
    .prepare(
      "SELECT id, user_id, parts, course_id, assigned_user_id, assigned_user_email FROM projects WHERE id = ?",
    )
    .get(id) as {
    id: string;
    user_id: string;
    parts?: string;
    course_id?: string | null;
    assigned_user_id?: string | null;
    assigned_user_email?: string | null;
  } | undefined;

  if (existing) {
    const partsRaw = (() => {
      try {
        return JSON.parse(String(existing.parts ?? "[]"));
      } catch {
        return [];
      }
    })();

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
      const existingPartsRaw = (() => {
        try {
          return JSON.parse(String(existing.parts ?? "[]"));
        } catch {
          return [];
        }
      })();
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
    partsJson = existing.parts;
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
    conn
      .prepare(
        `UPDATE projects SET title = ?, script = ?, audio_mode = ?, scenes = ?, parts = ?, thumbnail_url = ?, course_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        data.title,
        data.script ?? null,
        data.audio_mode,
        scenesJson,
        partsJson,
        data.thumbnail_url ?? null,
        courseId,
        now,
        id,
      );
  } else {
    conn
      .prepare(
        `INSERT INTO projects (id, user_id, title, script, audio_mode, scenes, parts, thumbnail_url, course_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  }
  return id;
}

function sqliteGetProject(
  userId: string,
  userEmail: string,
  id: string,
): LocalProjectRow | null {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const project = rowToProject(row);
  if (!userCanAccessProject({ userId, userEmail }, project)) return null;
  return project;
}

/** Admin / cross-user fetch — no owner filter. */
function sqliteGetProjectById(id: string): LocalProjectRow | null {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToProject(row) : null;
}

function sqliteListProjects(
  userId: string,
  userEmail: string,
  opts?: {
    courseId?: string | null;
    asAdmin?: boolean;
    /** When true, omit episodes with no course (non-admin default). */
    requireCourse?: boolean;
  },
): LocalProjectListItem[] {
  const conn = getDb();
  let rows: Record<string, unknown>[];
  /** Natural sort so "Episode 2" comes before "Episode 10". */
  const naturalByTitle = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.title ?? "").localeCompare(String(b.title ?? ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });


  if (opts?.asAdmin) {
    if (opts && "courseId" in opts) {
      if (opts.courseId === null) {
        rows = conn
          .prepare(
            `SELECT id, title, thumbnail_url, created_at, updated_at, audio_mode, scenes, parts, course_id,
                    assigned_user_id, assigned_user_email, user_id
             FROM projects WHERE course_id IS NULL ORDER BY updated_at DESC`,
          )
          .all() as Record<string, unknown>[];
      } else {
        rows = conn
          .prepare(
            `SELECT id, title, thumbnail_url, created_at, updated_at, audio_mode, scenes, parts, course_id,
                    assigned_user_id, assigned_user_email, user_id
             FROM projects WHERE course_id = ? ORDER BY title ASC`,
          )
          .all(opts.courseId) as Record<string, unknown>[];
      }
    } else if (opts?.requireCourse) {
      rows = conn
        .prepare(
          `SELECT id, title, thumbnail_url, created_at, updated_at, audio_mode, scenes, parts, course_id,
                  assigned_user_id, assigned_user_email, user_id
           FROM projects WHERE course_id IS NOT NULL ORDER BY updated_at DESC`,
        )
        .all() as Record<string, unknown>[];
    } else {
      rows = conn
        .prepare(
          `SELECT id, title, thumbnail_url, created_at, updated_at, audio_mode, scenes, parts, course_id,
                  assigned_user_id, assigned_user_email, user_id
           FROM projects ORDER BY updated_at DESC`,
        )
        .all() as Record<string, unknown>[];
    }
    return rows.map(toListItem);
  }

  // Owner + episode assignee + part assignee (scan candidates, filter in memory).
  if (opts && "courseId" in opts) {
    if (opts.courseId === null) {
      // Unassigned episodes are admin-only; never list for non-admins.
      return [];
    }
    rows = conn
      .prepare(
        `SELECT id, title, thumbnail_url, created_at, updated_at, audio_mode, scenes, parts, course_id,
                assigned_user_id, assigned_user_email, user_id
         FROM projects WHERE course_id = ? ORDER BY title ASC`,
      )
      .all(opts.courseId) as Record<string, unknown>[];
  } else {
    // Non-admins never browse unassigned episodes.
    rows = conn
      .prepare(
        `SELECT id, title, thumbnail_url, created_at, updated_at, audio_mode, scenes, parts, course_id,
                assigned_user_id, assigned_user_email, user_id
         FROM projects WHERE course_id IS NOT NULL ORDER BY updated_at DESC`,
      )
      .all() as Record<string, unknown>[];
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
          row.assigned_user_email != null ? String(row.assigned_user_email) : null,
        parts: (() => {
          try {
            return JSON.parse(String(row.parts ?? "[]"));
          } catch {
            return [];
          }
        })(),
        },
      ),
    )
    .map(toListItem);
}

/** Admin-only: set / clear episode-level assignee. */
function sqliteAssignEpisode(
  episodeId: string,
  assignee: { userId: string; email: string } | null,
): LocalProjectRow {
  const conn = getDb();
  const existing = conn
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(episodeId) as { id: string } | undefined;
  if (!existing) throw new Error("Episode not found.");
  const now = new Date().toISOString();
  conn
    .prepare(
      `UPDATE projects SET assigned_user_id = ?, assigned_user_email = ?, updated_at = ? WHERE id = ?`,
    )
    .run(assignee?.userId ?? null, assignee?.email ?? null, now, episodeId);
  const row = conn
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(episodeId) as Record<string, unknown>;
  return rowToProject(row);
}

/** Admin-only: set / clear part-level assignee inside episode parts JSON. */
function sqliteAssignPart(
  episodeId: string,
  partId: string,
  assignee: { userId: string; email: string } | null,
): LocalProjectRow {
  const conn = getDb();
  const row = conn
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(episodeId) as Record<string, unknown> | undefined;
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
  conn
    .prepare(`UPDATE projects SET parts = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(parts), now, episodeId);
  return { ...project, parts, updated_at: now };
}

/** Course IDs the user can open via episode/part assignment (not ownership). */
function sqliteAssignedCourseIds(userId: string, userEmail: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT course_id, user_id, assigned_user_id, assigned_user_email, parts
       FROM projects WHERE course_id IS NOT NULL`,
    )
    .all() as Record<string, unknown>[];
  const ids = new Set<string>();
  for (const row of rows) {
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
            row.assigned_user_email != null ? String(row.assigned_user_email) : null,
          parts: (() => {
            try {
              return JSON.parse(String(row.parts ?? "[]"));
            } catch {
              return [];
            }
          })(),
        },
      )
    ) {
      ids.add(courseId);
    }
  }
  return [...ids];
}

export interface LocalAssignmentItem {
  kind: "episode" | "part";
  episodeId: string;
  episodeTitle: string;
  courseId: string | null;
  partId?: string;
  partTitle?: string;
  assignedUserId: string;
  assignedUserEmail: string;
  /** Saved compose scenes on this part (part assignments only). */
  sceneCount?: number;
  updated_at: string;
}

/** Admin: total saved compose scenes per assignee across all parts. */
function sqliteSavedSceneCountsByUser(): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT parts FROM projects WHERE parts LIKE '%"assignedUserId"%'`)
    .all() as { parts: string }[];
  const byUser = new Map<string, number>();
  for (const row of rows) {
    let partsRaw: unknown = [];
    try {
      partsRaw = JSON.parse(String(row.parts ?? "[]"));
    } catch {
      continue;
    }
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
function sqliteListAssignments(): LocalAssignmentItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, title, course_id, assigned_user_id, assigned_user_email, parts, updated_at
       FROM projects
       WHERE assigned_user_id IS NOT NULL
          OR parts LIKE '%"assignedUserId"%'
       ORDER BY updated_at DESC`,
    )
    .all() as Record<string, unknown>[];

  const out: LocalAssignmentItem[] = [];
  for (const row of rows) {
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
    let partsRaw: unknown = [];
    try {
      partsRaw = JSON.parse(String(row.parts ?? "[]"));
    } catch {
      partsRaw = [];
    }
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
function sqliteClearAssignmentsForUser(userId: string): void {
  const conn = getDb();
  const now = new Date().toISOString();
  conn
    .prepare(
      `UPDATE projects SET assigned_user_id = NULL, assigned_user_email = NULL, updated_at = ?
       WHERE assigned_user_id = ?`,
    )
    .run(now, userId);

  const rows = conn
    .prepare(
      `SELECT id, parts FROM projects WHERE parts LIKE '%"assignedUserId"%'`,
    )
    .all() as { id: string; parts: string }[];
  for (const row of rows) {
    let partsRaw: unknown = [];
    try {
      partsRaw = JSON.parse(String(row.parts ?? "[]"));
    } catch {
      continue;
    }
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
      conn
        .prepare(`UPDATE projects SET parts = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(next), now, row.id);
    }
  }
}

export interface LocalProjectAdminItem extends LocalProjectListItem {
  user_id: string;
}

/** Admin: every project on this Mac, newest first. */
function sqliteListAllProjects(): LocalProjectAdminItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, user_id, title, thumbnail_url, created_at, updated_at, audio_mode, scenes, parts, course_id,
              assigned_user_id, assigned_user_email
       FROM projects ORDER BY updated_at DESC`,
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    ...toListItem(row),
    user_id: String(row.user_id),
  }));
}

function sqliteDeleteProject(_userId: string, _id: string): void {
  throw new Error("Project deletion is disabled. All projects are kept on the host machine.");
}


// --- Dual backend (Postgres when DATABASE_URL set) ---

export async function localSaveProject(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgSaveProject } = await import("@/lib/pg-projects-db");
    return pgSaveProject(...(args as [any, any, any, any?]));
  }
  return sqliteSaveProject(...(args as [any, any, any, any?]));
}

export async function localGetProject(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgGetProject } = await import("@/lib/pg-projects-db");
    return pgGetProject(...(args as [any, any, any]));
  }
  return sqliteGetProject(...(args as [any, any, any]));
}

export async function localGetProjectById(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgGetProjectById } = await import("@/lib/pg-projects-db");
    return pgGetProjectById(...(args as [any]));
  }
  return sqliteGetProjectById(...(args as [any]));
}

export async function localListProjects(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgListProjects } = await import("@/lib/pg-projects-db");
    return pgListProjects(...(args as [any, any, any?]));
  }
  return sqliteListProjects(...(args as [any, any, any?]));
}

export async function localAssignEpisode(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgAssignEpisode } = await import("@/lib/pg-projects-db");
    return pgAssignEpisode(...(args as [any, any]));
  }
  return sqliteAssignEpisode(...(args as [any, any]));
}

export async function localAssignPart(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgAssignPart } = await import("@/lib/pg-projects-db");
    return pgAssignPart(...(args as [any, any, any]));
  }
  return sqliteAssignPart(...(args as [any, any, any]));
}

export async function localAssignedCourseIds(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgAssignedCourseIds } = await import("@/lib/pg-projects-db");
    return pgAssignedCourseIds(...(args as [any, any]));
  }
  return sqliteAssignedCourseIds(...(args as [any, any]));
}

export async function localSavedSceneCountsByUser(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgSavedSceneCountsByUser } = await import("@/lib/pg-projects-db");
    return pgSavedSceneCountsByUser();
  }
  return sqliteSavedSceneCountsByUser();
}

export async function localListAssignments(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgListAssignments } = await import("@/lib/pg-projects-db");
    return pgListAssignments();
  }
  return sqliteListAssignments();
}

export async function localClearAssignmentsForUser(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgClearAssignmentsForUser } = await import("@/lib/pg-projects-db");
    return pgClearAssignmentsForUser(...(args as [any]));
  }
  return sqliteClearAssignmentsForUser(...(args as [any]));
}

export async function localListAllProjects(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgListAllProjects } = await import("@/lib/pg-projects-db");
    return pgListAllProjects();
  }
  return sqliteListAllProjects();
}

export async function localDeleteProject(...args: any[]): Promise<any> {
  if (usePostgres()) {
    const { pgDeleteProject } = await import("@/lib/pg-projects-db");
    return pgDeleteProject(...(args as [any, any]));
  }
  return sqliteDeleteProject(...(args as [any, any]));
}


function sqliteApplySubmitterParts(episodeId: string, parts: unknown): void {
  const conn = getDb();
  const existing = conn
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(episodeId) as { id: string } | undefined;
  if (!existing) throw new Error("Episode not found.");
  const now = new Date().toISOString();
  conn
    .prepare(`UPDATE projects SET parts = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(parts ?? []), now, episodeId);
}

export async function applySubmitterParts(...args: any[]): Promise<any> {
  if (usePostgres()) {
    throw new Error("Work merge is only supported on local SQLite (desktop / LAN Mac).");
  }
  return sqliteApplySubmitterParts(...(args as [any, any]));
}

/**
 * Upsert an episode row exactly as delivered by an admin assignment snapshot.
 * Used by work-sync when pulling assignments onto a collaborator machine.
 */
function sqliteApplySyncedEpisode(input: {
  episode: Record<string, any>;
  parts: unknown;
  isNew?: boolean;
}): void {
  const conn = getDb();
  const ep = input.episode ?? {};
  const id = String(ep.id ?? "");
  if (!id) throw new Error("Episode id required.");
  const now = new Date().toISOString();
  const partsJson = JSON.stringify(input.parts ?? []);
  const exists = conn.prepare("SELECT id FROM projects WHERE id = ?").get(id) as
    | { id: string }
    | undefined;

  if (exists) {
    conn
      .prepare(
        `UPDATE projects
           SET title = ?, parts = ?, course_id = ?, thumbnail_url = ?,
               assigned_user_id = ?, assigned_user_email = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        String(ep.title ?? "Untitled"),
        partsJson,
        ep.course_id ?? null,
        ep.thumbnail_url ?? null,
        ep.assigned_user_id ?? null,
        ep.assigned_user_email ?? null,
        now,
        id,
      );
    return;
  }

  conn
    .prepare(
      `INSERT INTO projects
         (id, user_id, title, script, audio_mode, scenes, parts, thumbnail_url,
          course_id, assigned_user_id, assigned_user_email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      String(ep.user_id ?? ""),
      String(ep.title ?? "Untitled"),
      ep.script ?? null,
      String(ep.audio_mode ?? "tts"),
      JSON.stringify(ep.scenes ?? []),
      partsJson,
      ep.thumbnail_url ?? null,
      ep.course_id ?? null,
      ep.assigned_user_id ?? null,
      ep.assigned_user_email ?? null,
      String(ep.created_at ?? now),
      now,
    );
}

export async function applySyncedEpisode(...args: any[]): Promise<any> {
  if (usePostgres()) {
    throw new Error("Assignment sync is only supported on local SQLite (desktop / LAN Mac).");
  }
  return sqliteApplySyncedEpisode(...(args as [any]));
}
