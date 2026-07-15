export type NormBbox = { x: number; y: number; w: number; h: number };

/** Pad tight detector boxes so hand-drawn strokes are not clipped when cropped. */
export function expandBboxForReveal(b: NormBbox, pad = 0.014): NormBbox {
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  const w = Math.min(1 - x, b.w + pad * 2);
  const h = Math.min(1 - y, b.h + pad * 2);
  return { x, y, w, h };
}

export function bboxArea(b: NormBbox): number {
  return b.w * b.h;
}

export function bboxIntersection(a: NormBbox, b: NormBbox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

export function bboxIou(a: NormBbox, b: NormBbox): number {
  const inter = bboxIntersection(a, b);
  const ua = bboxArea(a) + bboxArea(b) - inter;
  return ua > 0 ? inter / ua : 0;
}

/** True when `inner` sits almost entirely inside `outer` (nested card / double border). */
export function isMostlyContained(
  inner: NormBbox,
  outer: NormBbox,
  overlapRatio = 0.72,
): boolean {
  const innerArea = bboxArea(inner);
  if (innerArea <= 0) return false;
  const outerArea = bboxArea(outer);
  if (outerArea <= innerArea * 1.05) return false;
  return bboxIntersection(inner, outer) / innerArea >= overlapRatio;
}

function centerOf(b: NormBbox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function pointInBox(p: { x: number; y: number }, box: NormBbox): boolean {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

/**
 * Drop boxes nested inside larger ones — keep only outermost containers.
 * Layout-agnostic: uses bbox geometry only (containment / area / IoU), not scene content.
 */
export function filterOutNestedBoxes<T extends { bbox: NormBbox }>(boxes: T[]): T[] {
  if (boxes.length <= 1) return boxes;

  const sorted = [...boxes].sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox));
  const kept: T[] = [];

  for (const cand of sorted) {
    const nested = kept.some((outer) => isNestedInside(cand.bbox, outer.bbox));
    if (!nested) kept.push(cand);
  }

  return kept;
}

/** True when `candidate` should be treated as a child of `parent` (keep parent only). */
export function isNestedInside(candidate: NormBbox, parent: NormBbox): boolean {
  const cArea = bboxArea(candidate);
  const pArea = bboxArea(parent);
  if (pArea <= cArea * 1.05) return false;
  if (isMostlyContained(candidate, parent, 0.82)) return true;
  if (cArea < pArea * 0.55 && pointInBox(centerOf(candidate), parent)) return true;
  return false;
}

/**
 * Drop a large wrapper bbox that encloses multiple smaller siblings — DINO often
 * returns one "whole diagram" box alongside real cards (revealing the full image early).
 */
export function dropMegaWrapperBoxes<T extends { bbox: NormBbox }>(boxes: T[]): T[] {
  if (boxes.length <= 1) return boxes;
  return boxes.filter((candidate) => {
    const area = bboxArea(candidate.bbox);
    const { w, h } = candidate.bbox;

    // Hard cap: never keep a near-full-canvas box when other boxes exist.
    if (area > 0.48 || (w > 0.82 && h > 0.62)) {
      const hasSmallerSibling = boxes.some(
        (other) => other !== candidate && bboxArea(other.bbox) < area * 0.7,
      );
      if (hasSmallerSibling) return false;
    }

    if (area < 0.14) return true;

    const contained = boxes.filter((other) => {
      if (other === candidate) return false;
      const oArea = bboxArea(other.bbox);
      if (oArea >= area * 0.78) return false;
      if (isMostlyContained(other.bbox, candidate.bbox, 0.45)) return true;
      return pointInBox(centerOf(other.bbox), candidate.bbox);
    });
    return contained.length < 2;
  });
}
