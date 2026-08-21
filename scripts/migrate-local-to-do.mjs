#!/usr/bin/env node
/**
 * One-shot migrator: local SQLite + `.data` assets → Managed Postgres + DO Spaces.
 *
 * IMPORTANT: Point DATA_ROOT at a *copy* of production LAN data, not the live
 * folder used by `npm run dev:lan`. Example:
 *
 *   cp -a ../divStudio/.data ./migrate-data
 *   DATA_ROOT=./migrate-data DATABASE_URL=... SPACES_*=... node scripts/migrate-local-to-do.mjs
 *
 * Flags:
 *   --dry-run          Print actions only
 *   --skip-assets      Only migrate DB rows
 *   --skip-db          Only upload assets
 *   --course-id <uuid> Only migrate that course + its projects (or MIGRATE_COURSE_ID)
 *   --skip-exports     Default: skip .data/exports (large); pass --include-exports to upload
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipAssets = args.has("--skip-assets");
const skipDb = args.has("--skip-db");
const includeExports = args.has("--include-exports");

/** Optional: only migrate projects for this course id (plus the course row). */
function argValue(name) {
  const prefix = `${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length).trim();
  }
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("-")) {
    return process.argv[idx + 1].trim();
  }
  return "";
}
const onlyCourseId =
  process.env.MIGRATE_COURSE_ID?.trim() || argValue("--course-id") || "";


const dataRoot = process.env.DATA_ROOT?.trim() || path.join(process.cwd(), "migrate-data");
const projectsDb = process.env.LOCAL_PROJECTS_DB || path.join(dataRoot, "projects.db");
const appDb = process.env.LOCAL_APP_DB || path.join(dataRoot, "app.db");

function mustEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function spacesEndpoint() {
  const raw = mustEnv("SPACES_ENDPOINT");
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function spacesBasePrefix() {
  const base = (process.env.SPACES_BASE_PATH ?? process.env.SPACES_PREFIX ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return base ? `${base}/` : "";
}

async function withRetry(label, fn, attempts = 5) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e?.message || String(e);
      console.warn(`  retry ${i}/${attempts} ${label}: ${msg}`);
      if (i === attempts) throw e;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw last;
}

function pgUrl() {
  return mustEnv("DATABASE_URL")
    .replace(/([?&])sslmode=[^&]*/gi, "$1")
    .replace(/\?&/, "?")
    .replace(/[?&]$/, "");
}

async function connectPg() {
  const client = new pg.Client({
    connectionString: pgUrl(),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 60_000,
    ssl:
      process.env.PG_SSL === "0"
        ? false
        : { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== "0" },
  });
  // Prevent process crash on mid-query disconnects.
  client.on("error", (err) => {
    console.warn(`  pg client error: ${err.message}`);
  });
  await client.connect();
  await client.query("SET statement_timeout = 0");
  await client.query("SET idle_in_transaction_session_timeout = 0");
  await client.query("SET tcp_keepalives_idle = 30");
  await client.query("SET tcp_keepalives_interval = 10");
  await client.query("SET tcp_keepalives_count = 6");
  return client;
}

/** Split a JSON array string into <= maxBytes chunks (serialized array fragments). */
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

async function upsertProjectChunked(getClient, p, scenes, parts) {
  let client = await getClient();

  const isConnErr = (e) =>
    /terminat|closed|ECONNRESET|EPIPE|timeout|not queryable|connection error|Connection refused/i.test(
      e?.message || String(e),
    );

  const run = async (sql, params) => {
    try {
      return await client.query(sql, params);
    } catch (e) {
      if (!isConnErr(e)) throw e;
      try {
        client.end().catch(() => {});
      } catch {
        /* ignore */
      }
      client = await getClient(true);
      return client.query(sql, params);
    }
  };

  // 1) Row shell without the huge JSON payloads.
  await run(
    `INSERT INTO projects (
       id, user_id, title, script, audio_mode, scenes, parts,
       thumbnail_url, course_id, assigned_user_id, assigned_user_email,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,'[]'::jsonb,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET
       user_id=EXCLUDED.user_id,
       title=EXCLUDED.title,
       script=EXCLUDED.script,
       audio_mode=EXCLUDED.audio_mode,
       thumbnail_url=EXCLUDED.thumbnail_url,
       course_id=EXCLUDED.course_id,
       assigned_user_id=EXCLUDED.assigned_user_id,
       assigned_user_email=EXCLUDED.assigned_user_email,
       created_at=EXCLUDED.created_at,
       updated_at=EXCLUDED.updated_at,
       scenes='[]'::jsonb,
       parts='[]'::jsonb`,
    [
      p.id,
      p.user_id,
      p.title,
      p.script,
      p.audio_mode ?? "tts",
      p.thumbnail_url,
      p.course_id,
      p.assigned_user_id,
      p.assigned_user_email,
      p.created_at,
      p.updated_at,
    ],
  );

  // Top-level scenes[] (legacy / flat)
  const sceneChunks = chunkJsonArrayString(scenes, 1_500_000);
  console.log(`    top-level scenes chunks=${sceneChunks.length}`);
  for (let i = 0; i < sceneChunks.length; i++) {
    await withRetry(`scenes ${p.id} chunk ${i + 1}/${sceneChunks.length}`, () =>
      run(`UPDATE projects SET scenes = scenes || $2::jsonb WHERE id = $1`, [
        p.id,
        sceneChunks[i],
      ]),
    );
  }

  // parts[] — each part can be ~80MB because scenes are nested; append shell then scenes one-by-one.
  let partList;
  try {
    partList = JSON.parse(parts || "[]");
  } catch {
    partList = [];
    await withRetry(`parts-raw ${p.id}`, () =>
      run(`UPDATE projects SET parts = $2::jsonb WHERE id = $1`, [p.id, parts || "[]"]),
    );
  }

  if (Array.isArray(partList)) {
    console.log(`    parts objects=${partList.length}`);
    for (let pi = 0; pi < partList.length; pi++) {
      const part = partList[pi] ?? {};
      const nested = Array.isArray(part.scenes) ? part.scenes : [];
      const shell = { ...part, scenes: [] };
      console.log(
        `    part ${pi + 1}/${partList.length} nestedScenes=${nested.length}`,
      );
      await withRetry(`part-shell ${p.id}#${pi}`, () =>
        run(`UPDATE projects SET parts = parts || $2::jsonb WHERE id = $1`, [
          p.id,
          JSON.stringify([shell]),
        ]),
      );
      for (let si = 0; si < nested.length; si++) {
        const sceneJson = JSON.stringify([nested[si]]);
        await withRetry(
          `part-scene ${p.id}#${pi} scene ${si + 1}/${nested.length} (${sceneJson.length}b)`,
          () =>
            run(
              `UPDATE projects SET parts = jsonb_set(
                 parts,
                 ARRAY[$2::text, 'scenes'],
                 COALESCE(parts->($2)::int->'scenes', '[]'::jsonb) || $3::jsonb
               ) WHERE id = $1`,
              [p.id, String(pi), sceneJson],
            ),
        );
      }
    }
  }
}

async function migrateDb(initialClient) {
  console.log("Migrating SQLite → Postgres…");
  let client = initialClient;
  const forceReconnect = async (force = false) => {
    if (force || !client || client._ending || client._ended) {
      try {
        await client?.end?.();
      } catch {
        /* ignore */
      }
      client = await connectPg();
    }
    return client;
  };
  const getClient = async (force = false) => forceReconnect(force);

  await client.query("SET statement_timeout = 0");
  await client.query("SET idle_in_transaction_session_timeout = 0");

  const app = new Database(appDb, { readonly: true });
  const projects = new Database(projectsDb, { readonly: true });

  const users = app.prepare("SELECT * FROM users").all();
  const sessions = app.prepare("SELECT * FROM sessions").all();
  let imageAssets = [];
  try {
    imageAssets = app.prepare("SELECT * FROM image_assets").all();
  } catch {
    /* table may not exist */
  }
  const coursesAll = projects.prepare("SELECT * FROM courses").all();
  const courses = onlyCourseId
    ? coursesAll.filter((c) => c.id === onlyCourseId)
    : coursesAll;
  if (onlyCourseId && courses.length === 0) {
    throw new Error(`MIGRATE_COURSE_ID / --course-id not found: ${onlyCourseId}`);
  }
  const projectIds = onlyCourseId
    ? projects
        .prepare("SELECT id FROM projects WHERE course_id = ? ORDER BY id")
        .all(onlyCourseId)
    : projects.prepare("SELECT id FROM projects ORDER BY id").all();
  const projectById = projects.prepare("SELECT * FROM projects WHERE id = ?");

  console.log(
    `  users=${users.length} sessions=${sessions.length} courses=${courses.length}/${coursesAll.length} projects=${projectIds.length}${onlyCourseId ? ` (course ${onlyCourseId})` : ""} image_assets=${imageAssets.length}`,
  );

  if (dryRun) {
    app.close();
    projects.close();
    return;
  }

  try {
    for (const u of users) {
      try {
        await client.query(
          `INSERT INTO users (id, email, password_hash, created_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET
             email=EXCLUDED.email,
             password_hash=EXCLUDED.password_hash,
             created_at=EXCLUDED.created_at`,
          [u.id, u.email, u.password_hash, u.created_at],
        );
      } catch (e) {
        if (e?.code !== "23505") throw e;
        await client.query(
          `UPDATE users SET id=$1, password_hash=$3, created_at=$4 WHERE lower(email)=lower($2)`,
          [u.id, u.email, u.password_hash, u.created_at],
        );
      }
    }
    console.log(`  users done (${users.length})`);
    for (const s of sessions) {
      await client.query(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET
           user_id=EXCLUDED.user_id,
           token_hash=EXCLUDED.token_hash,
           expires_at=EXCLUDED.expires_at,
           created_at=EXCLUDED.created_at`,
        [s.id, s.user_id, s.token_hash, s.expires_at, s.created_at],
      );
    }
    console.log(`  sessions done (${sessions.length})`);
    for (const c of courses) {
      await client.query(
        `INSERT INTO courses (id, user_id, title, description, thumbnail_url, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           user_id=EXCLUDED.user_id,
           title=EXCLUDED.title,
           description=EXCLUDED.description,
           thumbnail_url=EXCLUDED.thumbnail_url,
           created_at=EXCLUDED.created_at,
           updated_at=EXCLUDED.updated_at`,
        [
          c.id,
          c.user_id,
          c.title,
          c.description,
          c.thumbnail_url,
          c.created_at,
          c.updated_at,
        ],
      );
    }
    console.log(`  courses done (${courses.length})`);

    let i = 0;
    for (const { id } of projectIds) {
      i += 1;
      const p = projectById.get(id);
      const scenes = typeof p.scenes === "string" ? p.scenes : JSON.stringify(p.scenes ?? []);
      const parts = typeof p.parts === "string" ? p.parts : JSON.stringify(p.parts ?? []);
      const mb = ((scenes.length + parts.length) / (1024 * 1024)).toFixed(1);

      // Resume: skip projects that already have substantial payload migrated.
      const check = await (await getClient()).query(
        `SELECT octet_length(scenes::text) AS sc, octet_length(parts::text) AS pa
         FROM projects WHERE id = $1`,
        [p.id],
      );
      const sc = Number(check.rows[0]?.sc ?? 0);
      const pa = Number(check.rows[0]?.pa ?? 0);
      // Allow 5% shrinkage vs source (jsonb normalization).
      if (sc + pa >= (scenes.length + parts.length) * 0.9 && sc + pa > 100) {
        console.log(
          `  project ${i}/${projectIds.length} ${p.id} "${p.title}" ~${mb}MB SKIP (already migrated)`,
        );
        continue;
      }

      console.log(`  project ${i}/${projectIds.length} ${p.id} "${p.title}" ~${mb}MB json`);
      await withRetry(`project ${p.id}`, async () => {
        await upsertProjectChunked(getClient, p, scenes, parts);
      });
    }
    console.log(`  projects done (${projectIds.length})`);

    for (const a of imageAssets) {
      await (await getClient()).query(
        `INSERT INTO image_assets (
           id, prompt, kind, public_url, embedding, usage_count, created_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           prompt=EXCLUDED.prompt,
           kind=EXCLUDED.kind,
           public_url=EXCLUDED.public_url,
           embedding=EXCLUDED.embedding,
           usage_count=EXCLUDED.usage_count,
           created_by=EXCLUDED.created_by,
           created_at=EXCLUDED.created_at`,
        [
          a.id,
          a.prompt,
          a.kind,
          a.public_url,
          a.embedding,
          a.usage_count ?? 0,
          a.created_by,
          a.created_at,
        ],
      );
    }
    console.log(`  image_assets done (${imageAssets.length})`);
  } finally {
    app.close();
    projects.close();
  }
  console.log("DB migrate done.");
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

async function uploadTree(s3, prefix, localDir) {
  const files = walkFiles(localDir);
  console.log(`  uploading ${files.length} files under ${prefix}/`);
  let n = 0;
  for (const full of files) {
    n += 1;
    const rel = path.relative(localDir, full).split(path.sep).join("/");
    const key = `${prefix}/${rel}`;
    const st = statSync(full);
    if (dryRun) {
      console.log(`    would put ${key} (${st.size} bytes)`);
      continue;
    }
    await withRetry(`put ${key}`, async () => {
      await s3.send(
        new PutObjectCommand({
          Bucket: mustEnv("SPACES_BUCKET"),
          Key: key,
          Body: createReadStream(full),
          ContentLength: st.size,
          ACL: "private",
        }),
      );
    });
    if (n % 25 === 0 || n === files.length) {
      console.log(`    ${n}/${files.length} put (last ${key}, ${st.size} bytes)`);
    }
  }
}

async function migrateAssets() {
  console.log("Uploading assets → Spaces…");
  const base = spacesBasePrefix();
  const s3 = new S3Client({
    endpoint: spacesEndpoint(),
    region: process.env.SPACES_REGION?.trim() || "blr1",
    credentials: {
      accessKeyId: mustEnv("SPACES_KEY"),
      secretAccessKey: mustEnv("SPACES_SECRET"),
    },
  });
  await uploadTree(s3, `${base}project-assets`.replace(/\/$/, ""), path.join(dataRoot, "project-assets"));
  await uploadTree(s3, `${base}app-assets`.replace(/\/$/, ""), path.join(dataRoot, "app-assets"));
  if (includeExports) {
    await uploadTree(s3, `${base}exports`.replace(/\/$/, ""), path.join(dataRoot, "exports"));
  } else {
    console.log("  skipping exports/ (pass --include-exports to upload)");
  }
  console.log("Asset upload done.");
}

async function main() {
  if (!existsSync(dataRoot)) {
    throw new Error(
      `DATA_ROOT not found: ${dataRoot}\nCopy a snapshot first, e.g. cp -a ../divStudio/.data ./migrate-data`,
    );
  }
  console.log(`DATA_ROOT=${dataRoot} dryRun=${dryRun}`);

  if (!skipDb) {
    if (!existsSync(projectsDb) || !existsSync(appDb)) {
      throw new Error(`Expected ${projectsDb} and ${appDb}`);
    }
    const client = await connectPg();
    const schema = readFileSync(
      path.join(process.cwd(), "migrations", "001_init.sql"),
      "utf8",
    );
    if (!dryRun) await client.query(schema);
    await migrateDb(client);
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }

  if (!skipAssets) {
    await migrateAssets();
  }

  console.log("All done. Keep LAN `.data` untouched until Droplet smoke tests pass.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
