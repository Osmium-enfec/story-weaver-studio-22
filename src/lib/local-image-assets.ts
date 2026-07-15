import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ImageAssetHit {
  id: string;
  public_url: string;
  similarity: number;
}

let db: Database.Database | null = null;

function dbPath(): string {
  return process.env.LOCAL_APP_DB ?? path.join(process.cwd(), ".data", "app.db");
}

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(dbPath()), { recursive: true });
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_assets (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      kind TEXT NOT NULL,
      public_url TEXT NOT NULL,
      embedding TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS image_assets_kind_idx ON image_assets (kind);
  `);
  return db;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function localMatchImageAsset(
  embedding: number[],
  kind: string,
  threshold: number,
): ImageAssetHit | null {
  const rows = getDb()
    .prepare("SELECT id, public_url, embedding FROM image_assets WHERE kind = ?")
    .all(kind) as { id: string; public_url: string; embedding: string }[];

  let best: ImageAssetHit | null = null;
  for (const row of rows) {
    let parsed: number[];
    try {
      parsed = JSON.parse(row.embedding);
      if (!Array.isArray(parsed)) continue;
    } catch {
      continue;
    }
    const similarity = cosineSimilarity(embedding, parsed);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { id: row.id, public_url: row.public_url, similarity };
    }
  }
  return best;
}

export function localBumpImageAssetUsage(id: string): void {
  getDb()
    .prepare("UPDATE image_assets SET usage_count = usage_count + 1 WHERE id = ?")
    .run(id);
}

export function localInsertImageAsset(input: {
  prompt: string;
  kind: string;
  public_url: string;
  embedding: number[];
  created_by?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO image_assets (id, prompt, kind, public_url, embedding, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.prompt,
      input.kind,
      input.public_url,
      JSON.stringify(input.embedding),
      input.created_by ?? null,
      new Date().toISOString(),
    );
}
