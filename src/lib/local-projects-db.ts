import path from "node:path";
import { hostProjectsDbPath } from "@/lib/host-storage";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface LocalProjectRow {
  id: string;
  user_id: string;
  title: string;
  script: string | null;
  audio_mode: string;
  scenes: unknown;
  parts?: unknown;
  thumbnail_url: string | null;
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
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function localSaveProject(
  userId: string,
  data: {
    id?: string;
    title: string;
    script?: string | null;
    audio_mode: string;
    scenes: unknown;
    parts?: unknown;
    thumbnail_url?: string | null;
  },
): string {
  const conn = getDb();
  const now = new Date().toISOString();
  const id = data.id ?? randomUUID();
  const scenesJson = JSON.stringify(data.scenes ?? []);

  const existing = conn
    .prepare("SELECT id, parts FROM projects WHERE id = ? AND user_id = ?")
    .get(id, userId) as { id: string; parts?: string } | undefined;

  let partsJson: string;
  if (data.parts !== undefined) {
    partsJson = JSON.stringify(data.parts);
  } else if (existing?.parts != null) {
    partsJson = existing.parts;
  } else {
    partsJson = "[]";
  }

  if (existing) {
    conn
      .prepare(
        `UPDATE projects SET title = ?, script = ?, audio_mode = ?, scenes = ?, parts = ?, thumbnail_url = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        data.title,
        data.script ?? null,
        data.audio_mode,
        scenesJson,
        partsJson,
        data.thumbnail_url ?? null,
        now,
        id,
        userId,
      );
  } else {
    conn
      .prepare(
        `INSERT INTO projects (id, user_id, title, script, audio_mode, scenes, parts, thumbnail_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        now,
        now,
      );
  }
  return id;
}

export function localGetProject(userId: string, id: string): LocalProjectRow | null {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?")
    .get(id, userId) as Record<string, unknown> | undefined;
  return row ? rowToProject(row) : null;
}

export function localListProjects(userId: string): LocalProjectListItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, title, thumbnail_url, created_at, updated_at, audio_mode, scenes
       FROM projects WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId) as Record<string, unknown>[];

  return rows.map((row) => {
    let sceneCount = 0;
    try {
      const parsed = JSON.parse(String(row.scenes ?? "[]"));
      sceneCount = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      sceneCount = 0;
    }
    return {
      id: String(row.id),
      title: String(row.title),
      thumbnail_url: row.thumbnail_url != null ? String(row.thumbnail_url) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      audio_mode: String(row.audio_mode ?? "tts"),
      scene_count: sceneCount,
    };
  });
}

export function localDeleteProject(_userId: string, _id: string): void {
  throw new Error("Project deletion is disabled. All projects are kept on the host machine.");
}
