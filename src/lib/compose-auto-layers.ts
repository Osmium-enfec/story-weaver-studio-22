import type { ComposeCrop, ComposePlacement } from "@/lib/compose-scene";
import { DEFAULT_PLACEMENT_SFX } from "@/lib/compose-scene";
import { extractLayer } from "@/lib/layer-compose";
import type { ReplicateSegment } from "@/lib/segment-layers.functions";

const MIN_AREA_FRAC = 0.002;
/** Masks covering nearly the whole frame are the background, not an element. */
const MAX_AREA_FRAC = 0.85;
const MAX_LAYERS = 20;

type SegmentResult =
  | { layers: ReplicateSegment[]; error?: never; fallback?: never }
  | { layers: ReplicateSegment[]; error: string; fallback: true };

export interface AutoLayerRunners {
  segment: (args: {
    data: {
      imageDataUrl: string;
      pointsPerSide?: number;
      predIouThresh?: number;
      stabilityScoreThresh?: number;
      useM2m?: boolean;
      maskLimit?: number;
    };
  }) => Promise<SegmentResult>;
  fetchMask: (args: { data: { url: string } }) => Promise<{ dataUrl: string }>;
}

/**
 * Run SAM 2 on a composite, composite each mask to a transparent PNG,
 * and return ComposeCrop[] ready for timeline placements.
 */
export async function autoLayersFromComposite(
  compositeDataUrl: string,
  runners: AutoLayerRunners,
): Promise<{ crops: ComposeCrop[]; warning?: string }> {
  const seg = await runners.segment({
    data: {
      imageDataUrl: compositeDataUrl,
      pointsPerSide: 32,
      predIouThresh: 0.9,
      stabilityScoreThresh: 0.96,
      useM2m: true,
      maskLimit: 24,
    },
  });

  if (("fallback" in seg && seg.fallback) || seg.layers.length === 0) {
    return {
      crops: [],
      warning: ("error" in seg ? seg.error : undefined) ?? "No layers detected.",
    };
  }

  const probe = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = compositeDataUrl;
  });
  const imgArea = Math.max(1, probe.naturalWidth * probe.naturalHeight);
  const minArea = imgArea * MIN_AREA_FRAC;
  const maxArea = imgArea * MAX_AREA_FRAC;

  const extracted: { crop: ComposeCrop; area: number; y: number }[] = [];

  for (let i = 0; i < seg.layers.length; i++) {
    const layer = seg.layers[i]!;
    try {
      const proxied = await runners.fetchMask({ data: { url: layer.maskUrl } });
      const bitmap = await extractLayer(compositeDataUrl, proxied.dataUrl);
      if (bitmap.area < minArea || bitmap.area > maxArea) continue;

      const W = probe.naturalWidth || 1;
      const H = probe.naturalHeight || 1;
      extracted.push({
        area: bitmap.area,
        y: bitmap.bbox.y,
        crop: {
          id: layer.id || `layer-${i}`,
          name: layer.label || `Layer ${extracted.length + 1}`,
          imageUrl: bitmap.pngUrl,
          bbox: {
            x: bitmap.bbox.x / W,
            y: bitmap.bbox.y / H,
            w: bitmap.bbox.w / W,
            h: bitmap.bbox.h / H,
          },
        },
      });
    } catch {
      // skip failed masks
    }
  }

  extracted.sort((a, b) => b.area - a.area || a.y - b.y);
  const crops = extracted.slice(0, MAX_LAYERS).map((e, i) => ({
    ...e.crop,
    name: `Layer ${i + 1}`,
    id: `layer-${i}-${Date.now().toString(36)}`,
  }));

  return {
    crops,
    warning: crops.length === 0 ? "SAM2 masks were empty after filtering." : undefined,
  };
}

/** Spread layer reveals evenly across narration. */
export function placementsFromLayers(
  crops: ComposeCrop[],
  durationMs: number,
): ComposePlacement[] {
  const n = crops.length;
  if (n === 0 || durationMs <= 0) return [];
  const usable = Math.max(1000, durationMs * 0.88);
  return crops.map((c, i) => ({
    id: `pl-${c.id}`,
    cropId: c.id,
    startMs: n <= 1 ? 0 : Math.round((usable * i) / (n - 1)),
    sfxUrl: DEFAULT_PLACEMENT_SFX,
  }));
}
