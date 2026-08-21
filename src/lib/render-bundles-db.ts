/**
 * "Ready for HD" bundles — frozen, render-ready snapshots of a part.
 *
 * Dual backend, same as projects: SQLite on self-hosted/LAN, Postgres (direct
 * or cloud REST) on the published build.
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { hostProjectsDbPath } from "@/lib/host-storage";
import { usePostgres } from "@/lib/runtime-backends";
import { pgQuery } from "@/lib/pg";

export type BundleStatus = "ready" | "rendering" | "done" | "failed";

export interface RenderBundleRow {
  id: string;
  project_id: string;
  part_id: string;
  owner_user_id: string;
  owner_email: string;
  episode_title: string;
  part_title: string;
  duration_ms: number;
  scene_count: number;
  ready_at: string;
  status: BundleStatus;
  payload: unknown;
  output_url: string | null;
  error: string | null;
}

export interface RenderBundleListItem {
  id: string;
  projectId: string;
  partId: string;
  episodeTitle: string;
  partTitle: string;
  ownerEmail: string;
  durationMs: number;
  sceneCount: number;
  readyAt: string;
  status: BundleStatus;
  outputUrl: string | null;
  error: string | null;
}

export function toListItem(row: RenderBundleRow): RenderBundleListItem {
  return {
    id: row.id,
    projectId: row.project_id,
    partId: row.part_id,
    episodeTitle: row.episode_title,
    partTitle: row.part_title,
    ownerEmail: row.owner_email,
    durationMs: row.duration_ms,
    sceneCount: row.scene_count,
    readyAt: row.ready_at,
    status: row.status,
    outputUrl: row.output_url,
    error: row.error,
  };
}

export interface CreateBundleInput {
  projectId: string;
  partId: string;
  ownerUserId: string;
  ownerEmail: string;
  episodeTitle: string;
  partTitle: string;
  durationMs: number;
  sceneCount: number;
  payload: unknown;
}

/* ------------------------------ SQLite ------------------------------ */

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(hostProjectsDbPath()), { recursive: true });
  db = new Database(hostProjectsDbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS render_bundles (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      episode_title TEXT NOT NULL,
      part_title TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      scene_count INTEGER NOT NULL DEFAULT 0,
      ready_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      payload TEXT NOT NULL DEFAULT '{}',
      output_url TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS render_bundles_ready_idx
      ON render_bundles (ready_at DESC);
  `);
  return db;
}

function sqliteRow(row: Record<string, unknown>): RenderBundleRow {
  let payload: unknown = {};
  try {
    payload = JSON.parse(String(row.payload ?? "{}"));
  } catch {
    payload = {};
  }
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    part_id: String(row.part_id),
    owner_user_id: String(row.owner_user_id),
    owner_email: String(row.owner_email),
    episode_title: String(row.episode_title),
    part_title: String(row.part_title),
    duration_ms: Number(row.duration_ms ?? 0),
    scene_count: Number(row.scene_count ?? 0),
    ready_at: String(row.ready_at),
    status: String(row.status ?? "ready") as BundleStatus,
    payload,
    output_url: row.output_url != null ? String(row.output_url) : null,
    error: row.error != null ? String(row.error) : null,
  };
}

/* ----------------------------- Postgres ----------------------------- */

const PG_DDL = `
CREATE TABLE IF NOT EXISTS render_bundles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  episode_title TEXT NOT NULL,
  part_title TEXT NOT NULL,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  scene_count INTEGER NOT NULL DEFAULT 0,
  ready_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_url TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS render_bundles_ready_idx ON render_bundles (ready_at DESC);
`;

let pgReady: Promise<void> | null = null;

async function ensurePgTable(): Promise<void> {
  if (!pgReady) {
    pgReady = (async () => {
      for (const stmt of PG_DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
        await pgQuery(stmt);
      }
    })().catch((err) => {
      pgReady = null;
      throw err;
    });
  }
  return pgReady;
}

const PG_SELECT = `
  id, project_id, part_id, owner_user_id, owner_email, episode_title, part_title,
  duration_ms, scene_count, ready_at::text AS ready_at, status, payload,
  output_url, error
`;

function pgRow(row: Record<string, unknown>): RenderBundleRow {
  const raw = row.payload;
  let payload: unknown = raw ?? {};
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }
  return {
    ...sqliteRow({ ...row, payload: "{}" }),
    payload,
  };
}

/* ------------------------------- API -------------------------------- */

export async function createRenderBundle(
  input: CreateBundleInput,
): Promise<RenderBundleRow> {
  const id = randomUUID();
  const readyAt = new Date().toISOString();
  const payloadJson = JSON.stringify(input.payload ?? {});

  if (usePostgres()) {
    await ensurePgTable();
    // A new freeze supersedes previous ready snapshots of the same part.
    await pgQuery(
      `DELETE FROM render_bundles WHERE part_id = $1 AND status IN ('ready','failed')`,
      [input.partId],
    );
    await pgQuery(
      `INSERT INTO render_bundles
        (id, project_id, part_id, owner_user_id, owner_email, episode_title,
         part_title, duration_ms, scene_count, ready_at, status, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready',$11::jsonb)`,
      [
        id,
        input.projectId,
        input.partId,
        input.ownerUserId,
        input.ownerEmail,
        input.episodeTitle,
        input.partTitle,
        Math.round(input.durationMs),
        input.sceneCount,
        readyAt,
        payloadJson,
      ],
    );
    const found = await getRenderBundle(id);
    if (!found) throw new Error("Bundle insert failed");
    return found;
  }

  const d = getDb();
  d.prepare(
    `DELETE FROM render_bundles WHERE part_id = ? AND status IN ('ready','failed')`,
  ).run(input.partId);
  d.prepare(
    `INSERT INTO render_bundles
      (id, project_id, part_id, owner_user_id, owner_email, episode_title,
       part_title, duration_ms, scene_count, ready_at, status, payload)
     VALUES (?,?,?,?,?,?,?,?,?,?,'ready',?)`,
  ).run(
    id,
    input.projectId,
    input.partId,
    input.ownerUserId,
    input.ownerEmail,
    input.episodeTitle,
    input.partTitle,
    Math.round(input.durationMs),
    input.sceneCount,
    readyAt,
    payloadJson,
  );
  const found = await getRenderBundle(id);
  if (!found) throw new Error("Bundle insert failed");
  return found;
}

export async function getRenderBundle(id: string): Promise<RenderBundleRow | null> {
  if (usePostgres()) {
    await ensurePgTable();
    const res = await pgQuery(
      `SELECT ${PG_SELECT} FROM render_bundles WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? pgRow(row as Record<string, unknown>) : null;
  }
  const row = getDb()
    .prepare(`SELECT * FROM render_bundles WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? sqliteRow(row) : null;
}

export async function listRenderBundles(opts?: {
  ownerUserId?: string;
  status?: BundleStatus | "all";
}): Promise<RenderBundleRow[]> {
  const status = opts?.status ?? "all";

  if (usePostgres()) {
    await ensurePgTable();
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.ownerUserId) {
      params.push(opts.ownerUserId);
      where.push(`owner_user_id = $${params.length}`);
    }
    if (status !== "all") {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    const res = await pgQuery(
      `SELECT ${PG_SELECT} FROM render_bundles
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ready_at DESC`,
      params,
    );
    return res.rows.map((r) => pgRow(r as Record<string, unknown>));
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.ownerUserId) {
    where.push("owner_user_id = ?");
    params.push(opts.ownerUserId);
  }
  if (status !== "all") {
    where.push("status = ?");
    params.push(status);
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM render_bundles
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ready_at DESC`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(sqliteRow);
}

export async function updateRenderBundle(
  id: string,
  patch: { status?: BundleStatus; outputUrl?: string | null; error?: string | null },
): Promise<RenderBundleRow | null> {
  const current = await getRenderBundle(id);
  if (!current) return null;
  const status = patch.status ?? current.status;
  const outputUrl =
    patch.outputUrl === undefined ? current.output_url : patch.outputUrl;
  const error = patch.error === undefined ? current.error : patch.error;

  if (usePostgres()) {
    await pgQuery(
      `UPDATE render_bundles SET status = $2, output_url = $3, error = $4 WHERE id = $1`,
      [id, status, outputUrl, error],
    );
  } else {
    getDb()
      .prepare(
        `UPDATE render_bundles SET status = ?, output_url = ?, error = ? WHERE id = ?`,
      )
      .run(status, outputUrl, error, id);
  }
  return getRenderBundle(id);
}

export async function deleteRenderBundle(id: string): Promise<void> {
  if (usePostgres()) {
    await pgQuery(`DELETE FROM render_bundles WHERE id = $1`, [id]);
    return;
  }
  getDb().prepare(`DELETE FROM render_bundles WHERE id = ?`).run(id);
}
