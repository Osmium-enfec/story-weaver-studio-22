// Sequential "white box" reveal covers driven by Grounding-DINO hand-drawn
// box detection. Each cover is a plain white rectangle placed over a
// detected box; covers fade out one-by-one during scene playback, in
// reading order (top → bottom, then left → right).
//
// Covers are stored in NORMALIZED coordinates (0..1) relative to the source
// image's natural size, so the player and rasterizer can place them on top
// of the object-contain draw rect regardless of container size.

import type { detectBoxesInImage } from "./detect-boxes.functions";

export interface RevealCover {
  id: string;
  /** Shared 1x1 white PNG data URL — the cover is just a filled rectangle. */
  pngUrl: string;
  /** Normalized 0..1 bbox relative to the source image natural dims. */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface RevealBuild {
  covers: RevealCover[];
  aspect: number; // width / height of the source image
}

// 1x1 pure-white PNG. Any browser/canvas can stretch this to a filled rect.
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
  data: { imageDataUrl: string };
}) => ReturnType<typeof detectBoxesInImage>;

/**
 * Detect hand-drawn boxes in the composite and return per-box white covers
 * sorted in reading order (top → bottom, left → right within a row).
 */
export async function buildSceneRevealBoxes(
  imageUrl: string,
  runDetect: DetectRunner,
): Promise<RevealBuild | null> {
  const img = await loadImg(imageUrl).catch(() => null);
  if (!img) return null;
  const W = img.naturalWidth || 1;
  const H = img.naturalHeight || 1;
  const aspect = W / H;

  const res = await runDetect({ data: { imageDataUrl: imageUrl } }).catch((e) => {
    console.warn("[reveal] detect failed:", (e as any)?.message ?? e);
    return null;
  });
  if (!res || res.fallback || !res.boxes || res.boxes.length === 0) return null;

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

/**
 * Sequential per-box opacity — matches segment-lab timing exactly:
 * 250ms lead-in, then each box takes a 900ms fade-out with a 900ms
 * step between box starts (no overlap → distinct one-by-one reveals).
 * If the scene is too short to fit all boxes at that cadence, we compress
 * the step but keep the fade snappy so reveals still feel punchy.
 */
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
  // Reserve at least the final 200ms fully revealed.
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
  // easeInOut for a smoother, more perceptible fade
  return t < 0.5 ? 1 - 2 * t * t : 1 - (1 - 2 * (1 - t) * (1 - t));
}
