import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { hostAppAssetsRoot, hostProjectAssetsRoot } from "@/lib/host-storage";
import { useCloudStorage, useSpaces } from "@/lib/runtime-backends";

export type AssetKind = "project" | "app";

/** Cloud bucket layout mirrors the disk layout: `<kind>/<relPath>`. */
const CLOUD_BUCKET = "project-assets";

function cloudObjectUrl(kind: AssetKind, rel: string): string {
  const base = process.env.SUPABASE_URL!.trim().replace(/\/+$/, "");
  const prefix = kind === "app" ? "app-assets" : "project-assets";
  return `${base}/storage/v1/object/${CLOUD_BUCKET}/${prefix}/${rel}`;
}

function cloudHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  return { apikey: key, Authorization: `Bearer ${key}` };
}

type S3Like = {
  send: (command: unknown) => Promise<any>;
};

let spacesClientPromise: Promise<S3Like> | null = null;

function spacesEndpoint(): string {
  const raw = process.env.SPACES_ENDPOINT!.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function spacesBasePrefix(): string {
  const base = (process.env.SPACES_BASE_PATH ?? process.env.SPACES_PREFIX ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return base ? `${base}/` : "";
}

async function spacesClient(): Promise<any> {
  if (!spacesClientPromise) {
    spacesClientPromise = (async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const region = process.env.SPACES_REGION?.trim() || "blr1";
      return new S3Client({
        endpoint: spacesEndpoint(),
        region,
        credentials: {
          accessKeyId: process.env.SPACES_KEY!.trim(),
          secretAccessKey: process.env.SPACES_SECRET!.trim(),
        },
        forcePathStyle: false,
      }) as any;
    })();
  }
  return spacesClientPromise!;
}

function bucket(): string {
  return process.env.SPACES_BUCKET!.trim();
}

function spacesKey(kind: AssetKind, rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  const kindPrefix = kind === "app" ? "app-assets" : "project-assets";
  return `${spacesBasePrefix()}${kindPrefix}/${clean}`;
}

function localRoot(kind: AssetKind): string {
  return kind === "app" ? hostAppAssetsRoot() : hostProjectAssetsRoot();
}

/** Write bytes and return the public app path (`/api/assets/...` or `/api/app-assets/...`). */
export async function putAsset(opts: {
  kind: AssetKind;
  /** Relative path under the kind root, e.g. `{userId}/{projectId}/{file}`. */
  relPath: string;
  body: Buffer;
  contentType?: string;
}): Promise<string> {
  const rel = opts.relPath.replace(/^\/+/, "");
  if (!rel || rel.includes("..")) throw new Error("Invalid asset path");

  if (useCloudStorage()) {
    const res = await fetch(cloudObjectUrl(opts.kind, rel), {
      method: "POST",
      headers: {
        ...cloudHeaders(),
        "Content-Type": opts.contentType ?? "application/octet-stream",
        "x-upsert": "true",
      },
      body: new Uint8Array(opts.body),
    });
    if (!res.ok) {
      throw new Error(`Asset upload failed [${res.status}]: ${await res.text()}`);
    }
  } else if (useSpaces()) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await spacesClient();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: spacesKey(opts.kind, rel),
        Body: opts.body,
        ContentType: opts.contentType,
        ACL: "private",
      }),
    );
  } else {
    const full = path.join(localRoot(opts.kind), rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, opts.body);
  }

  const prefix = opts.kind === "app" ? "/api/app-assets" : "/api/assets";
  return `${prefix}/${rel}`;
}

/**
 * Direct, time-limited download URL for an object, so large media (e.g. .mov
 * screen recordings) never streams through the app server / edge worker.
 * Returns null when assets live on local disk (dev), where proxying is fine.
 */
export async function signedAssetUrl(
  kind: AssetKind,
  relPath: string,
  expiresInSeconds = 60 * 60 * 6,
): Promise<string | null> {
  const rel = relPath.replace(/^\/+/, "");
  if (!rel || rel.includes("..")) return null;

  if (useCloudStorage()) {
    const base = process.env.SUPABASE_URL!.trim().replace(/\/+$/, "");
    const prefix = kind === "app" ? "app-assets" : "project-assets";
    const res = await fetch(
      `${base}/storage/v1/object/sign/${CLOUD_BUCKET}/${prefix}/${rel}`,
      {
        method: "POST",
        headers: { ...cloudHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const signed = json.signedURL ?? json.signedUrl;
    if (!signed) return null;
    return `${base}/storage/v1${signed.startsWith("/") ? signed : `/${signed}`}`;
  }

  if (useSpaces()) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const client = await spacesClient();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket(), Key: spacesKey(kind, rel) }),
      { expiresIn: expiresInSeconds },
    );
  }

  return null;
}

export type AssetReadResult = {
  status: 200 | 206;
  body: ReadableStream;
  headers: Record<string, string>;
};

function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header || !header.startsWith("bytes=")) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startRaw = m[1];
  const endRaw = m[2];
  if (!startRaw && !endRaw) return null;

  let start: number;
  let end: number;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

/** Serve a stored asset with optional HTTP Range (local disk or Spaces). */
export async function readAsset(opts: {
  kind: AssetKind;
  relPath: string;
  contentType: string;
  rangeHeader: string | null;
}): Promise<AssetReadResult | null> {
  const rel = opts.relPath.replace(/^\/+/, "");
  if (!rel || rel.includes("..")) return null;

  const common = {
    "Content-Type": opts.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  if (useCloudStorage()) {
    const res = await fetch(cloudObjectUrl(opts.kind, rel), {
      headers: {
        ...cloudHeaders(),
        ...(opts.rangeHeader ? { Range: opts.rangeHeader } : {}),
      },
    });
    if (!res.ok || !res.body) return null;
    const len = res.headers.get("content-length");
    const contentRange = res.headers.get("content-range");
    return {
      status: res.status === 206 ? 206 : 200,
      body: res.body,
      headers: {
        ...common,
        ...(len ? { "Content-Length": len } : {}),
        ...(contentRange ? { "Content-Range": contentRange } : {}),
      },
    };
  }

  if (useSpaces()) {
    const { GetObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const key = spacesKey(opts.kind, rel);
    const client = await spacesClient();
    let size: number;
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket(), Key: key }),
      );
      size = Number(head.ContentLength ?? 0);
    } catch {
      return null;
    }
    if (!Number.isFinite(size) || size < 0) return null;

    const range = parseByteRange(opts.rangeHeader, size);
    const get = await client.send(
      new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    const body = get.Body;
    if (!body) return null;
    const webStream =
      typeof body.transformToWebStream === "function"
        ? body.transformToWebStream()
        : (Readable.toWeb(body as any) as ReadableStream);

    if (range) {
      const { start, end } = range;
      return {
        status: 206,
        body: webStream as ReadableStream,
        headers: {
          ...common,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
        },
      };
    }
    return {
      status: 200,
      body: webStream as ReadableStream,
      headers: {
        ...common,
        "Content-Length": String(size),
      },
    };
  }

  const full = path.join(localRoot(opts.kind), rel);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(localRoot(opts.kind)))) return null;
  if (!existsSync(resolved)) return null;

  const { size } = statSync(resolved);
  const range = parseByteRange(opts.rangeHeader, size);
  if (range) {
    const { start, end } = range;
    const stream = createReadStream(resolved, { start, end });
    return {
      status: 206,
      body: Readable.toWeb(stream) as ReadableStream,
      headers: {
        ...common,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    };
  }
  const stream = createReadStream(resolved);
  return {
    status: 200,
    body: Readable.toWeb(stream) as ReadableStream,
    headers: {
      ...common,
      "Content-Length": String(size),
    },
  };
}

/** Download asset bytes to a local file (for ffmpeg / export scratch). */
export async function materializeAssetToFile(
  kind: AssetKind,
  relPath: string,
  destPath: string,
): Promise<void> {
  const rel = relPath.replace(/^\/+/, "");
  mkdirSync(path.dirname(destPath), { recursive: true });

  if (useCloudStorage()) {
    const res = await fetch(cloudObjectUrl(kind, rel), { headers: cloudHeaders() });
    if (!res.ok) throw new Error(`Missing cloud object: ${rel} (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    writeFileSync(destPath, Buffer.from(bytes));
    return;
  }

  if (!useSpaces()) {
    const { copyFileSync } = await import("node:fs");
    const src = path.join(localRoot(kind), rel);
    copyFileSync(src, destPath);
    return;
  }

  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const get = await (await spacesClient()).send(
    new GetObjectCommand({
      Bucket: bucket(),
      Key: spacesKey(kind, rel),
    }),
  );
  const bytes = await get.Body?.transformToByteArray();
  if (!bytes) throw new Error(`Missing Spaces object: ${rel}`);
  writeFileSync(destPath, Buffer.from(bytes));
}
