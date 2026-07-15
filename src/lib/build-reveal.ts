// Box reveal covers — same Grounding-DINO path as segment-lab.

import type { detectBoxesInImage } from "./detect-boxes.functions";
import { bboxArea, bboxIou, filterOutNestedBoxes } from "./bbox-utils";

export type BoxRole = "title" | "subtitle" | "footer" | "content" | "hub";

export interface RevealCover {
  id: string;
  pngUrl: string;
  bbox: { x: number; y: number; w: number; h: number };
  revealStartMs?: number;
  revealFadeMs?: number;
  role?: BoxRole;
  label?: string;
  matchTerms?: string[];
  revealMatchPhrase?: string;
  revealMatchSource?: "speech" | "interpolated" | "fixed" | "fallback";
}

export interface RevealBuild {
  covers: RevealCover[];
  aspect: number;
}

export const WHITE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

type DetectRunner = (args: {
  data: { imageDataUrl: string; boxThreshold?: number; textThreshold?: number };
}) => ReturnType<typeof detectBoxesInImage>;

/** Detect boxes + sort reading order (segment-lab analyze()). */
export async function buildSceneRevealBoxes(
  imageUrl: string,
  runDetect: DetectRunner,
): Promise<RevealBuild | null> {
  const img = await loadImg(imageUrl).catch(() => null);
  if (!img) return null;
  const aspect = (img.naturalWidth || 1) / (img.naturalHeight || 1);

  const res = await runDetect({ data: { imageDataUrl: imageUrl } }).catch(() => null);
  if (!res || res.fallback || !res.boxes?.length) {
    return { covers: [], aspect };
  }

  const rowTol = 0.05;
  const sorted = [...res.boxes].sort((a, b) => {
    const ay = a.bbox.y + a.bbox.h / 2;
    const by = b.bbox.y + b.bbox.h / 2;
    if (Math.abs(ay - by) > rowTol) return ay - by;
    return a.bbox.x + a.bbox.w / 2 - (b.bbox.x + b.bbox.w / 2);
  });

  const covers: RevealCover[] = sorted.map((b, i) => ({
    id: `box-${i}`,
    pngUrl: WHITE_PIXEL_PNG,
    bbox: b.bbox,
  }));

  return { covers, aspect };
}

function normLabelKey(label?: string): string {
  return (label ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop nested / duplicate detections so each card syncs once (avoids duplicate Integer/Float @ 22s).
 */
export function dedupeRevealCovers(covers: RevealCover[]): RevealCover[] {
  if (covers.length <= 1) return covers;

  let list = filterOutNestedBoxes(covers);

  const iouKept: RevealCover[] = [];
  for (const c of [...list].sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox))) {
    if (iouKept.some((k) => bboxIou(k.bbox, c.bbox) > 0.42)) continue;
    iouKept.push(c);
  }
  list = iouKept;

  const seenLabels = new Set<string>();
  const out: RevealCover[] = [];
  for (const c of [...list].sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox))) {
    const role = c.role ?? "content";
    const label = normLabelKey(c.label);
    const isStructural = role === "title" || role === "subtitle" || role === "footer";
    if (!isStructural && label.length > 1 && !/^box \d+$/.test(label)) {
      const key = `${role}:${label}`;
      if (seenLabels.has(key)) continue;
      seenLabels.add(key);
    }
    out.push(c);
  }

  const rowTol = 0.05;
  out.sort((a, b) => {
    const ay = a.bbox.y + a.bbox.h / 2;
    const by = b.bbox.y + b.bbox.h / 2;
    if (Math.abs(ay - by) > rowTol) return ay - by;
    return a.bbox.x + a.bbox.w / 2 - (b.bbox.x + b.bbox.w / 2);
  });

  return out.map((c, i) => ({ ...c, id: `box-${i}` }));
}

export function coverOpacityAt(
  progress: number,
  index: number,
  total: number,
  durationMs: number = 15000,
): number {
  const LEAD_MS = 250;
  const IDEAL_STEP_MS = 900;
  const IDEAL_FADE_MS = 900;
  const n = Math.max(1, total);
  const usable = Math.max(1, durationMs - LEAD_MS - 200);
  const idealTotal = n * IDEAL_STEP_MS + IDEAL_FADE_MS;
  const scale = idealTotal > usable ? usable / idealTotal : 1;
  const stepMs = IDEAL_STEP_MS * scale;
  const fadeMs = IDEAL_FADE_MS * scale;
  const tMs = progress * durationMs;
  const startMs = LEAD_MS + index * stepMs;
  const endMs = startMs + fadeMs;
  if (tMs <= startMs) return 1;
  if (tMs >= endMs) return 0;
  const t = (tMs - startMs) / (endMs - startMs);
  return t < 0.5 ? 1 - 2 * t * t : 1 - (1 - 2 * (1 - t) * (1 - t));
}

export function coverRevealOpacity(
  progress: number,
  index: number,
  total: number,
  durationMs: number = 15000,
): number {
  return 1 - coverOpacityAt(progress, index, total, durationMs);
}
