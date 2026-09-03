import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { hostProjectsDbPath } from "@/lib/host-storage";
import { usePostgres } from "@/lib/runtime-backends";
import { REVIEW_FIELDS, type ReviewField } from "@/lib/review-permissions";

/**
 * Per-user extra grants for the shared review sheet. Admins manage these from
 * the admin page; a granted field can be edited on every row by that user.
 */

function norm(email: string): string {
  return email.trim().toLowerCase();
}

function parseFields(raw: unknown): ReviewField[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ReviewField => (REVIEW_FIELDS as string[]).includes(s));
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const file = hostProjectsDbPath();
  mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_permissions (
      email TEXT PRIMARY KEY,
      fields TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

let pgReady: Promise<void> | null = null;

async function ensurePgTable(): Promise<void> {
  if (!pgReady) {
    const { pgQuery } = await import("@/lib/pg");
    pgReady = pgQuery(
      `CREATE TABLE IF NOT EXISTS review_permissions (
         email TEXT PRIMARY KEY,
         fields TEXT NOT NULL DEFAULT '',
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    ).then(() => undefined);
  }
  await pgReady;
}

/** All grants, keyed by lowercase email. */
export async function listReviewGrants(): Promise<Record<string, ReviewField[]>> {
  const out: Record<string, ReviewField[]> = {};
  if (usePostgres()) {
    await ensurePgTable();
    const { pgQuery } = await import("@/lib/pg");
    const res = await pgQuery<{ email: string; fields: string }>(
      `SELECT email, fields FROM review_permissions`,
    );
    for (const r of res.rows) out[norm(r.email)] = parseFields(r.fields);
    return out;
  }
  const rows = getDb()
    .prepare(`SELECT email, fields FROM review_permissions`)
    .all() as Array<{ email: string; fields: string }>;
  for (const r of rows) out[norm(r.email)] = parseFields(r.fields);
  return out;
}

export async function getReviewGrants(email: string): Promise<ReviewField[]> {
  const key = norm(email);
  if (!key) return [];
  if (usePostgres()) {
    await ensurePgTable();
    const { pgQuery } = await import("@/lib/pg");
    const res = await pgQuery<{ fields: string }>(
      `SELECT fields FROM review_permissions WHERE email = $1`,
      [key],
    );
    return parseFields(res.rows[0]?.fields);
  }
  const row = getDb()
    .prepare(`SELECT fields FROM review_permissions WHERE email = ?`)
    .get(key) as { fields?: string } | undefined;
  return parseFields(row?.fields);
}

export async function setReviewGrants(
  email: string,
  fields: ReviewField[],
): Promise<ReviewField[]> {
  const key = norm(email);
  const value = [...new Set(fields)]
    .filter((f) => (REVIEW_FIELDS as string[]).includes(f))
    .join(",");
  if (usePostgres()) {
    await ensurePgTable();
    const { pgQuery } = await import("@/lib/pg");
    await pgQuery(
      `INSERT INTO review_permissions (email, fields, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (email) DO UPDATE
         SET fields = EXCLUDED.fields, updated_at = now()`,
      [key, value],
    );
    return parseFields(value);
  }
  getDb()
    .prepare(
      `INSERT INTO review_permissions (email, fields, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET fields = excluded.fields, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
  return parseFields(value);
}
