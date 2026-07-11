// Build "white cover" overlays from a composite image using Grounded-SAM
// segmentation. Covers are stored in NORMALIZED coordinates (0..1) relative
// to the source image's natural size, so the player and rasterizer can place
// them on top of the object-contain draw rect regardless of container size.

import {
  extractWhiteCover,
  buildResidualCover,
  type LayerBitmap,
} from "./layer-compose";
import type { segmentImageLayers } from "./segment-layers.functions";

export interface RevealCover {
  id: string;
  pngUrl: string;
  /** Normalized 0..1 bbox relative to the source image natural dims. */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface RevealBuild {
  covers: RevealCover[];
  aspect: number; // width / height of the source image
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

type SegRunner = (args: {
  data: { imageDataUrl: string; labels?: string[] };
}) => Promise<{ layers?: { id: string; label: string; maskUrl: string }[]; fallback?: boolean; error?: string }>;

export async function buildSceneRevealCovers(
  imageUrl: string,
  runSegment: SegRunner,
  labels?: string[],
): Promise<RevealBuild | null> {
  const img = await loadImg(imageUrl).catch(() => null);
  if (!img) return null;
  const W = img.naturalWidth || 1;
  const H = img.naturalHeight || 1;
  const aspect = W / H;

  const res = await runSegment({ data: { imageDataUrl: imageUrl, labels } }).catch((e) => {
    console.warn("[reveal] segment failed:", e?.message ?? e);
    return null;
  });
  if (!res || res.fallback || !res.layers || res.layers.length === 0) return null;

  const covers: RevealCover[] = [];
  for (const l of res.layers) {
    try {
      const cov = await extractWhiteCover(imageUrl, l.maskUrl);
      if (cov.area > 0 && cov.pngUrl) {
        covers.push({
          id: l.id,
          pngUrl: cov.pngUrl,
          bbox: {
            x: cov.bbox.x / W,
            y: cov.bbox.y / H,
            w: cov.bbox.w / W,
            h: cov.bbox.h / H,
          },
        });
      }
    } catch (e) {
      console.warn("[reveal] cover extract failed", l.label, e);
    }
  }

  try {
    const residual = await buildResidualCover(
      imageUrl,
      res.layers.map((l) => l.maskUrl),
    );
    if (residual.area > 0 && residual.pngUrl) {
      covers.push({
        id: "__residual__",
        pngUrl: residual.pngUrl,
        bbox: {
          x: residual.bbox.x / W,
          y: residual.bbox.y / H,
          w: residual.bbox.w / W,
          h: residual.bbox.h / H,
        },
      });
    }
  } catch (e) {
    console.warn("[reveal] residual failed", e);
  }

  return { covers, aspect };
}

/**
 * Progress-driven cover opacity: fully opaque at scene start, eased out to
 * transparent by ~35% of the scene. All covers fade together.
 */
export function coverOpacityAt(progress: number): number {
  const FADE_START = 0.03;
  const FADE_END = 0.35;
  if (progress <= FADE_START) return 1;
  if (progress >= FADE_END) return 0;
  const t = (progress - FADE_START) / (FADE_END - FADE_START);
  const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
  return 1 - eased;
}
