#!/usr/bin/env node
/**
 * One-shot migrator: Lovable Cloud (managed Postgres, `app` schema) → your own
 * Postgres (e.g. DO Managed Postgres) for self-hosting Div Studio.
 *
 * Media files are NOT touched — they already live in Spaces and the app serves
 * them via /api/assets/... regardless of which DB is active.
 *
 * Usage (run where managed cloud PG access exists, e.g. the Lovable sandbox):
 *   DATABASE_URL=postgres://user:pass@host:25060/db?sslmode=require \
 *   node scripts/migrate-cloud-to-do.mjs [--dry-run]
 * Source reads use the sandbox's read-only PG* env vars — no service key needed.
 * With no DATABASE_URL, --dry-run just counts source rows.
 *
 * Options:
 *   --dry-run     Read & count everything, write nothing.
 *   --skip-sessions  Do not copy login sessions (users must sign in again).
 *
 * Safe to re-run: every write is an upsert, and big projects are verified by
 * payload size so already-migrated rows are skipped (resume-friendly).
 */

import pg from "pg";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipSessions = args.has("--skip-sessions");

function mustEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}


// Source: read-only SQL access to Lovable Cloud via the managed psql role
// (PG* env vars). SELECT-only — the migrator never writes to the source.
let sourceClient;
async function cloudQuery(q, params = []) {
  if (!sourceClient) {
    if (!process.env.PGHOST) {
      throw new Error("Missing PG* env vars for cloud source access");
    }
    sourceClient = new pg.Client({ ssl: { rejectUnauthorized: false } });
    await sourceClient.connect();
    try {
      await sourceClient.query("SET statement_timeout = 0");
    } catch {
      /* restricted role may not change session settings — fine */
    }
  }
  const res = await sourceClient.query(q, params);
  return { rows: res.rows, rowCount: res.rowCount ?? 0 };
}

/** Fetch a big jsonb column as text, in slices, to keep responses small. */
async function cloudReadJsonText(table, id, column) {
  const { rows } = await cloudQuery(
    `SELECT octet_length(${column}::text) AS len FROM app.${table} WHERE id = $1`,
    [id],
  );
  const len = Number(rows[0]?.len ?? 0);
  if (len === 0) return "[]";
  const SLICE = 1_000_000;
  let out = "";
  for (let from = 1; from <= len; from += SLICE) {
    const part = await cloudQuery(
      `SELECT substring(${column}::text FROM $2 FOR ${SLICE}) AS s FROM app.${table} WHERE id = $1`,
      [id, from],
    );
    out += part.rows[0]?.s ?? "";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Target: plain pg client against your own Postgres.
// ---------------------------------------------------------------------------
function pgClient() {
  const url = mustEnv("DATABASE_URL")
    .replace(/([?&])sslmode=[^&]*/gi, "$1")
    .replace(/\?&/, "?")
    .replace(/[?&]$/, "");
  return new pg.Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
}

function chunkJsonArrayString(jsonStr, maxBytes = 1_500_000) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr || "[]");
  } catch {
    return [jsonStr && jsonStr.length ? jsonStr : "[]"];
  }
  if (!Array.isArray(parsed)) return [JSON.stringify(parsed)];
  if (parsed.length === 0) return ["[]"];
  const chunks = [];
  let cur = [];
  for (const el of parsed) {
    const trial = JSON.stringify(cur.concat([el]));
    if (cur.length && trial.length > maxBytes) {
      chunks.push(JSON.stringify(cur));
      cur = [el];
    } else {
      cur.push(el);
    }
  }
  if (cur.length) chunks.push(JSON.stringify(cur));
  return chunks;
}

async function upsertProjectChunked(client, p, scenes, parts) {
  await client.query(
    `INSERT INTO projects (
       id, user_id, title, script, audio_mode, scenes, parts,
       thumbnail_url, course_id, assigned_user_id, assigned_user_email,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,'[]'::jsonb,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET
       user_id=EXCLUDED.user_id, title=EXCLUDED.title, script=EXCLUDED.script,
       audio_mode=EXCLUDED.audio_mode, thumbnail_url=EXCLUDED.thumbnail_url,
       course_id=EXCLUDED.course_id, assigned_user_id=EXCLUDED.assigned_user_id,
       assigned_user_email=EXCLUDED.assigned_user_email,
       created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at,
       scenes='[]'::jsonb, parts='[]'::jsonb`,
    [
      p.id, p.user_id, p.title, p.script, p.audio_mode ?? "tts",
      p.thumbnail_url, p.course_id, p.assigned_user_id, p.assigned_user_email,
      p.created_at, p.updated_at,
    ],
  );

  for (const chunk of chunkJsonArrayString(scenes)) {
    await client.query(`UPDATE projects SET scenes = scenes || $2::jsonb WHERE id = $1`, [p.id, chunk]);
  }

  let partList;
  try {
    partList = JSON.parse(parts || "[]");
  } catch {
    partList = null;
  }
  if (!Array.isArray(partList)) {
    await client.query(`UPDATE projects SET parts = $2::jsonb WHERE id = $1`, [p.id, parts || "[]"]);
    return;
  }
  for (let pi = 0; pi < partList.length; pi++) {
    const part = partList[pi] ?? {};
    const nested = Array.isArray(part.scenes) ? part.scenes : [];
    const shell = { ...part, scenes: [] };
    await client.query(`UPDATE projects SET parts = parts || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify([shell])]);
    for (const scene of nested) {
      await client.query(
        `UPDATE projects SET parts = jsonb_set(
           parts, ARRAY[$2::text, 'scenes'],
           COALESCE(parts->($2)::int->'scenes', '[]'::jsonb) || $3::jsonb
         ) WHERE id = $1`,
        [p.id, String(pi), JSON.stringify([scene])],
      );
    }
  }
}

async function copySimpleTable(client, table, columns, conflictCols) {
  const { rows } = await cloudQuery(`SELECT ${columns.join(", ")} FROM app.${table}`);
  console.log(`  ${table}: ${rows.length} rows`);
  if (dryRun) return;
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const updates = columns
    .filter((c) => !conflictCols.includes(c))
    .map((c) => `${c}=EXCLUDED.${c}`)
    .join(", ");
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
    ON CONFLICT (${conflictCols.join(", ")}) DO UPDATE SET ${updates}`;
  for (const r of rows) {
    await client.query(sql, columns.map((c) => r[c]));
  }
}

async function main() {
  console.log(`cloud → do migrate  dryRun=${dryRun}  skipSessions=${skipSessions}`);

  // Target: your own Postgres. Not needed for a source-count-only dry run.
  const client = process.env.DATABASE_URL?.trim() ? pgClient() : null;
  if (client) {
    await client.connect();
    await client.query("SET statement_timeout = 0");
  } else if (!dryRun) {
    throw new Error("Missing env DATABASE_URL (required for a real migration)");
  } else {
    console.log("(DATABASE_URL not set — counting source rows only)");
  }

  // 1) Schema on the target.
  if (client && !dryRun) {
    const { readFileSync } = await import("node:fs");
    const schema = readFileSync(new URL("../migrations/001_init.sql", import.meta.url), "utf8");
    await client.query(schema);
    console.log("target schema ensured");
  }

  // 2) Small tables.
  await copySimpleTable(client, "users", ["id", "email", "password_hash", "created_at"], ["id"]);
  if (!skipSessions) {
    await copySimpleTable(client, "sessions", ["id", "user_id", "token_hash", "expires_at", "created_at"], ["id"]);
  }
  await copySimpleTable(
    client, "courses",
    ["id", "user_id", "title", "description", "thumbnail_url", "created_at", "updated_at"],
    ["id"],
  );
  await copySimpleTable(
    client, "image_assets",
    ["id", "prompt", "kind", "public_url", "embedding", "usage_count", "created_by", "created_at"],
    ["id"],
  );
  await copySimpleTable(
    client, "episode_reviews",
    ["project_id", "course_id", "parts_checked", "review_status", "issues_found",
     "correction_status", "assignee_email", "rendered_uploaded", "updated_by_email", "updated_at"],
    ["project_id"],
  );
  await copySimpleTable(
    client, "part_reviews",
    ["project_id", "part_id", "course_id", "script_status", "recording_status", "review_status",
     "issues_found", "correction_status", "assignee_email", "rendered_uploaded",
     "updated_by_email", "updated_at"],
    ["project_id", "part_id"],
  );

  // 3) Projects — big JSON payloads, copied one at a time in slices.
  const { rows: metas } = await cloudQuery(
    `SELECT id, user_id, title, script, audio_mode, thumbnail_url, course_id,
            assigned_user_id, assigned_user_email, created_at, updated_at,
            octet_length(scenes::text) AS sc, octet_length(parts::text) AS pa
     FROM app.projects ORDER BY id`,
  );
  console.log(`  projects: ${metas.length}`);
  let i = 0;
  for (const p of metas) {
    i += 1;
    const srcBytes = Number(p.sc) + Number(p.pa);
    const mb = (srcBytes / (1024 * 1024)).toFixed(1);

    if (!dryRun) {
      const check = await client.query(
        `SELECT octet_length(scenes::text) AS sc, octet_length(parts::text) AS pa FROM projects WHERE id = $1`,
        [p.id],
      );
      const dstBytes = Number(check.rows[0]?.sc ?? 0) + Number(check.rows[0]?.pa ?? 0);
      if (dstBytes >= srcBytes * 0.9 && dstBytes > 100) {
        console.log(`  project ${i}/${metas.length} ${p.id} "${p.title}" ~${mb}MB SKIP (already migrated)`);
        continue;
      }
    }

    console.log(`  project ${i}/${metas.length} ${p.id} "${p.title}" ~${mb}MB`);
    const scenes = await cloudReadJsonText("projects", p.id, "scenes");
    const parts = await cloudReadJsonText("projects", p.id, "parts");
    if (!dryRun) await upsertProjectChunked(client, p, scenes, parts);
  }

  if (client) await client.end();
  console.log("Done. Point the droplet app at DATABASE_URL and smoke-test before switching traffic.");
}

main().catch(async (err) => {
  console.error(err);
  try { if (sourceClient) await sourceClient.end(); } catch {}
  process.exit(1);
});
