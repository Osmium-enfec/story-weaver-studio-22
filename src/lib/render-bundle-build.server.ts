/**
 * Freeze a stitched part into a render-ready HD bundle payload.
 *
 * The payload is exactly what the Explainer render agent consumes today
 * (same shape as POST /api/export), with every media URL rewritten to an
 * absolute HTTPS URL that a remote Mac can download with the render key.
 */
import type { ProjectPart } from "@/lib/project-parts";
import { getProjectParts } from "@/lib/project-parts";

export interface BundlePayload {
  filename: string;
  quality: "hd";
  masterAudioUrl?: string;
  scenes: unknown[];
  background?: unknown;
  bgm?: unknown;
}

/** Public origin used for absolute asset URLs inside a frozen bundle. */
export function bundleBaseUrl(request: Request): string {
  const env = process.env.RENDER_PUBLIC_BASE_URL?.trim() || process.env.EXPORT_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (new URL(request.url).protocol === "https:" ? "https" : "http");
  if (host) return `${proto}://${host}`;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

const EPHEMERAL = /^(blob:|data:|file:)/i;

/** Rewrite one URL string to something downloadable from outside the browser. */
function absolutize(value: string, base: string): string {
  const v = value.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/api/assets/")) {
    return `${base}/api/public/assets/project/${v.slice("/api/assets/".length)}`;
  }
  if (v.startsWith("/api/app-assets/")) {
    return `${base}/api/public/assets/app/${v.slice("/api/app-assets/".length)}`;
  }
  if (v.startsWith("/")) return `${base}${v}`;
  return v;
}

/** Deep-walk any JSON value and absolutize URL-looking strings. */
function rewriteUrls<T>(value: T, base: string, found: string[]): T {
  if (typeof value === "string") {
    if (EPHEMERAL.test(value)) {
      found.push(value.slice(0, 40));
      return value;
    }
    if (value.startsWith("/") || /^https?:\/\//i.test(value)) {
      return absolutize(value, base) as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteUrls(v, base, found)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteUrls(v, base, found);
    }
    return out as unknown as T;
  }
  return value;
}

function safeFilename(episodeTitle: string, partTitle: string): string {
  const clean = (s: string) => s.replace(/[^\w.\- ]+/g, "").trim();
  const name = `${clean(episodeTitle)} ${clean(partTitle)}`.replace(/\s+/g, " ").trim();
  return `${name || "part"}-1080p.mp4`;
}

export class BundleValidationError extends Error {}

export function findPart(project: { parts?: unknown }, partId: string): ProjectPart | null {
  return getProjectParts(project).find((p) => p.id === partId) ?? null;
}

/**
 * Validate the part is stitched and produce the frozen payload.
 * Throws BundleValidationError with a member-readable message when not ready.
 */
export function buildBundlePayload(opts: {
  episodeTitle: string;
  part: ProjectPart;
  baseUrl: string;
}): { payload: BundlePayload; durationMs: number; sceneCount: number } {
  const { part, baseUrl } = opts;
  const scenes = Array.isArray(part.scenes) ? part.scenes : [];

  if (scenes.length === 0) {
    throw new BundleValidationError("This part has no scenes. Stitch the part first.");
  }
  if (!part.masterAudioUrl?.trim()) {
    throw new BundleValidationError(
      "No stitched narration found. Stitch all scenes and Save part, then mark Ready for HD.",
    );
  }
  if (scenes.length > 1) {
    const untimed = scenes.filter(
      (s) =>
        typeof (s as { startMs?: number }).startMs !== "number" ||
        typeof (s as { endMs?: number }).endMs !== "number",
    );
    if (untimed.length > 0) {
      throw new BundleValidationError(
        `${untimed.length} scene(s) have no stitch timing. Re-stitch the part, then Save part.`,
      );
    }
  }

  const ephemeral: string[] = [];
  const rewrittenScenes = rewriteUrls(scenes, baseUrl, ephemeral) as unknown[];
  const masterAudioUrl = rewriteUrls(part.masterAudioUrl, baseUrl, ephemeral);
  const bgm = part.bgm ? (rewriteUrls(part.bgm, baseUrl, ephemeral) as unknown) : null;

  if (ephemeral.length > 0) {
    throw new BundleValidationError(
      "Some media is still only in the browser (blob/data URLs). Save the part again so the files upload to the server, then mark Ready for HD.",
    );
  }

  const durationMs =
    part.durationMs ||
    scenes.reduce(
      (max, s) => Math.max(max, Number((s as { endMs?: number }).endMs ?? 0)),
      0,
    );

  return {
    payload: {
      filename: safeFilename(opts.episodeTitle, part.title),
      quality: "hd",
      masterAudioUrl,
      scenes: rewrittenScenes,
      background: rewriteUrls(
        (part as unknown as { background?: unknown }).background ?? null,
        baseUrl,
        ephemeral,
      ),
      bgm,
    },
    durationMs,
    sceneCount: scenes.length,
  };
}
