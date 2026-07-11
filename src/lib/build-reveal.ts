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
 * Sequential per-box opacity: each cover fades out in its own slot within
 * the first ~65% of the scene, in the order the covers array was built.
 */
export function coverOpacityAt(
  progress: number,
  index: number,
  total: number,
): number {
  const FADE_START = 0.03;
  const FADE_END = 0.65;
  const slot = Math.max(0.01, (FADE_END - FADE_START) / Math.max(1, total));
  const start = FADE_START + index * slot;
  const end = start + slot;
  if (progress <= start) return 1;
  if (progress >= end) return 0;
  const t = (progress - start) / (end - start);
  return Math.pow(1 - t, 3); // easeOutCubic on the fade-OUT
}
