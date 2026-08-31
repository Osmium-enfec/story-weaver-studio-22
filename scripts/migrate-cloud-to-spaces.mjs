#!/usr/bin/env node
/**
 * One-time migration: copy every object from the cloud storage bucket
 * (project-assets) to DigitalOcean Spaces, keeping the same key layout
 * (`project-assets/<rel>` and `app-assets/<rel>`).
 *
 * Usage:
 *   node scripts/migrate-cloud-to-spaces.mjs --dry-run
 *   node scripts/migrate-cloud-to-spaces.mjs
 *
 * Env required:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   SPACES_ENDPOINT, SPACES_REGION, SPACES_BUCKET, SPACES_KEY, SPACES_SECRET
 *
 * Resume-safe: objects already present in Spaces with the same size are skipped.
 */
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const DRY_RUN = process.argv.includes("--dry-run");
const BUCKET = "project-assets";
const PREFIXES = ["project-assets/", "app-assets/"];

function need(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const SUPA_URL = need("SUPABASE_URL").replace(/\/+$/, "");
const SUPA_KEY = need("SUPABASE_SERVICE_ROLE_KEY");
const SPACES_BUCKET = need("SPACES_BUCKET");
const SPACES_REGION = process.env.SPACES_REGION?.trim() || "blr1";
const SPACES_ENDPOINT = need("SPACES_ENDPOINT");
const BASE_PREFIX = (process.env.SPACES_BASE_PATH ?? process.env.SPACES_PREFIX ?? "")
  .trim()
  .replace(/^\/+|\/+$/g, "");

const s3 = new S3Client({
  endpoint: /^https?:\/\//i.test(SPACES_ENDPOINT) ? SPACES_ENDPOINT : `https://${SPACES_ENDPOINT}`,
  region: SPACES_REGION,
  credentials: {
    accessKeyId: need("SPACES_KEY"),
    secretAccessKey: need("SPACES_SECRET"),
  },
  forcePathStyle: false,
});

const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

async function listAll(prefix) {
  const out = [];
  const queue = [prefix];
  while (queue.length) {
    const current = queue.shift();
    let offset = 0;
    const limit = 1000;
    for (;;) {
      const res = await fetch(`${SUPA_URL}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers: { ...supaHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          prefix: current,
          limit,
          offset,
          sortBy: { column: "name", order: "asc" },
        }),
      });
      if (!res.ok) throw new Error(`List failed [${res.status}]: ${await res.text()}`);
      const rows = await res.json();
      for (const r of rows) {
        if (r.id) out.push({ key: `${current}${r.name}`, size: r.metadata?.size ?? null });
        else queue.push(`${current}${r.name}/`); // folder → recurse
      }
      if (rows.length < limit) break;
      offset += limit;
    }
  }
  return out;
}


async function existsInSpaces(key, size) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: SPACES_BUCKET, Key: key }));
    if (size == null) return true;
    return Number(head.ContentLength) === Number(size);
  } catch {
    return false;
  }
}

const CONCURRENCY = Number(process.env.MIGRATE_CONCURRENCY ?? 12);

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "COPY"} (concurrency ${CONCURRENCY})`);
  let total = 0, copied = 0, skipped = 0, failed = 0;

  for (const prefix of PREFIXES) {
    const objects = await listAll(prefix);
    console.log(`\n${prefix}: ${objects.length} objects`);
    let idx = 0;

    async function worker() {
      for (;;) {
        const i = idx++;
        if (i >= objects.length) return;
        const obj = objects[i];
        total++;
        const destKey = (BASE_PREFIX ? `${BASE_PREFIX}/` : "") + obj.key;
        try {
          if (await existsInSpaces(destKey, obj.size)) {
            skipped++;
            continue;
          }
          if (DRY_RUN) {
            copied++;
            continue;
          }
          const res = await fetch(`${SUPA_URL}/storage/v1/object/${BUCKET}/${obj.key}`, {
            headers: supaHeaders,
          });
          if (!res.ok) throw new Error(`download ${res.status}`);
          const body = Buffer.from(await res.arrayBuffer());
          await s3.send(
            new PutObjectCommand({
              Bucket: SPACES_BUCKET,
              Key: destKey,
              Body: body,
              ContentType: res.headers.get("content-type") ?? "application/octet-stream",
              ACL: "private",
            }),
          );
          copied++;
          if ((copied + skipped) % 100 === 0) {
            console.log(`  progress ${copied + skipped}/${objects.length} (copied ${copied}, skipped ${skipped})`);
          }
        } catch (e) {
          failed++;
          console.error(`  FAILED ${obj.key}: ${e.message}`);
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  console.log(`\nDone. total=${total} copied=${copied} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(2);
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});
