import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { uploadReferenceImage } from "@/lib/replicate-image";

/**
 * The app's fixed house style: every generated image is conditioned on these
 * references, so all scenes share one look.
 *
 * Sources live in style-refs/ as SVG (editable) plus a committed PNG next to
 * each — Replicate rejects raw SVG and there is no canvas on the server, so the
 * PNGs are pre-rasterised by scripts/rasterise-style-refs.ts.
 */

/** md §2 — Replicate takes at most 5 reference images. */
const MAX_REFERENCES = 5;

/** Re-upload before Replicate's 24h expiry rather than at the edge of it. */
const REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;

let cache: { urls: string[]; expiresAt: number } | null = null;
let inFlight: Promise<string[]> | null = null;

function styleRefsDir(): string {
  return process.env.STYLE_REFS_DIR ?? path.join(process.cwd(), "style-refs");
}

/** Pre-rasterised PNGs, sorted for a stable order across restarts. */
function referencePngPaths(): string[] {
  const dir = styleRefsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .sort()
    .slice(0, MAX_REFERENCES)
    .map((f) => path.join(dir, f));
}

export function houseStyleReferenceCount(): number {
  return referencePngPaths().length;
}

async function uploadAll(): Promise<string[]> {
  const paths = referencePngPaths();
  if (!paths.length) return [];

  const uploaded = await Promise.all(
    paths.map((p) => uploadReferenceImage(readFileSync(p), "image/png")),
  );
  cache = {
    urls: uploaded.map((u) => u.url),
    expiresAt: Math.min(...uploaded.map((u) => u.expiresAt)),
  };
  return cache.urls;
}

/**
 * Replicate file URLs for the house-style references, uploading only when the
 * cache is cold or close to expiry. Concurrent callers share one upload.
 */
export async function houseStyleReferenceUrls(): Promise<string[]> {
  if (cache && Date.now() < cache.expiresAt - REFRESH_MARGIN_MS) return cache.urls;
  if (inFlight) return inFlight;

  inFlight = uploadAll().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
