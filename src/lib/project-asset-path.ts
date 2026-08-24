import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { hostProjectAssetsRoot } from "@/lib/host-storage";
import { materializeAssetToFile, putAsset } from "@/lib/object-storage";
import { scratchRoot, useCloudStorage, useSpaces } from "@/lib/runtime-backends";

/**
 * Resolve `/api/assets/{userId}/...` to a local file path for ffmpeg.
 * With Spaces: downloads into scratch. With disk: uses `.data/project-assets`.
 */
export async function resolveUserAssetLocalPath(
  url: string,
  userId: string,
  scratchSubdir: string,
): Promise<string | null> {
  if (!url.startsWith("/api/assets/")) return null;
  const rel = decodeURIComponent(url.slice("/api/assets/".length).split("?")[0]);
  if (!rel || rel.includes("..")) return null;
  // Shared catalog: assets may be owned by another collaborator/admin, so we
  // only enforce the `{ownerId}/{projectId}/{file}` shape, not the requester id.
  const segments = rel.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  void userId;

  if (useSpaces() || useCloudStorage()) {
    // Never reuse a materialized filename: concurrent/retried requests can
    // otherwise collide while ffmpeg still has the previous copy open.
    const dest = path.join(
      scratchRoot(),
      scratchSubdir,
      `${randomUUID()}-${path.basename(rel)}`,
    );
    let lastErr: unknown = null;
    // Object storage can lag a beat right after upload — retry briefly.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await materializeAssetToFile("project", rel, dest);
        return dest;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    // Fall through to disk (hybrid hosts keep a local copy).
    const localFull = path.resolve(path.join(hostProjectAssetsRoot(), rel));
    if (
      localFull.startsWith(path.resolve(hostProjectAssetsRoot())) &&
      existsSync(localFull)
    ) {
      return localFull;
    }
    throw new Error(
      `Could not read the uploaded video from storage (${rel}): ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  const full = path.join(hostProjectAssetsRoot(), rel);
  const resolved = path.resolve(full);
  const assetsRoot = path.resolve(hostProjectAssetsRoot());
  if (!resolved.startsWith(assetsRoot)) return null;
  if (!existsSync(resolved)) return null;
  return resolved;
}



/** Persist a finished file under project assets (disk or Spaces) and return `/api/assets/...`. */
export async function persistProjectLocalFile(opts: {
  userId: string;
  projectId: string;
  filename: string;
  localPath: string;
  contentType?: string;
}): Promise<string> {
  const relPath = path.posix.join(opts.userId, opts.projectId, opts.filename);
  if (useSpaces() || useCloudStorage()) {
    const body = readFileSync(opts.localPath);
    return putAsset({
      kind: "project",
      relPath,
      body,
      contentType: opts.contentType,
    });
  }
  const dest = path.join(hostProjectAssetsRoot(), opts.userId, opts.projectId, opts.filename);
  mkdirSync(path.dirname(dest), { recursive: true });
  if (path.resolve(opts.localPath) !== path.resolve(dest)) {
    const { copyFileSync } = await import("node:fs");
    copyFileSync(opts.localPath, dest);
  }
  return `/api/assets/${relPath}`;
}
