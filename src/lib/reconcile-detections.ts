// Pure helpers for merging detections coming from multiple detectors
// (Gemini vision, Florence-2 dense-region-caption, Florence-2 OCR).
//
// Everything here is client-safe (no Node, no fetch).

export type DetType = "text" | "object" | "icon" | "arrow" | "frame";
export type DetSource = "gemini" | "florence" | "ocr";

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detection {
  label: string;
  bbox: Bbox;
  confidence: number; // 0..1
  type: DetType;
  source: DetSource;
}

export interface RejectedDetection extends Detection {
  reason: string;
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "of",
  "with",
  "on",
  "in",
  "for",
  "to",
  "at",
  "by",
]);

function normLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normLabel(s)
    .split(" ")
    .filter((t) => t.length > 2 && !STOP.has(t));
}

export function iou(a: Bbox, b: Bbox): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function similarLabels(a: string, b: string): boolean {
  const na = normLabel(a);
  const nb = normLabel(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(tokens(a));
  const tb = tokens(b);
  if (!tb.length) return false;
  let overlap = 0;
  for (const t of tb) if (ta.has(t)) overlap++;
  return overlap / tb.length >= 0.6;
}

// Source priority: OCR wins for text; Florence wins over Gemini for objects.
function priority(d: Detection): number {
  if (d.type === "text" && d.source === "ocr") return 100;
  if (d.source === "florence") return 60;
  if (d.source === "gemini") return 50;
  if (d.source === "ocr") return 40;
  return 0;
}

/**
 * Merge overlapping detections (IoU > iouThresh) that describe the same thing.
 * The kept detection is the one with highest (priority + confidence*10).
 * Everything with confidence < minConf is moved to `rejected`.
 * Detections whose bbox area is tiny (<0.001) or covers >95% of the canvas
 * are also rejected.
 */
export function reconcile(
  inputs: Detection[],
  opts: { iouThresh?: number; minConf?: number; maxCount?: number } = {},
): { kept: Detection[]; rejected: RejectedDetection[] } {
  const iouThresh = opts.iouThresh ?? 0.55;
  const minConf = opts.minConf ?? 0.28;
  const maxCount = opts.maxCount ?? 30;

  const rejected: RejectedDetection[] = [];

  // Sanity gate first.
  const gated: Detection[] = [];
  for (const d of inputs) {
    const area = d.bbox.w * d.bbox.h;
    if (area < 0.001) {
      rejected.push({ ...d, reason: "bbox too small" });
      continue;
    }
    if (area > 0.95) {
      rejected.push({ ...d, reason: "bbox covers whole image" });
      continue;
    }
    if (d.confidence < minConf) {
      // Keep if no other detector saw it in this area — decided after merge.
      gated.push(d);
      continue;
    }
    gated.push(d);
  }

  // Sort by descending priority + confidence so the "winner" of each cluster
  // is visited first.
  gated.sort((a, b) => priority(b) + b.confidence * 10 - (priority(a) + a.confidence * 10));

  const kept: Detection[] = [];
  const consumed = new Array(gated.length).fill(false);

  for (let i = 0; i < gated.length; i++) {
    if (consumed[i]) continue;
    const cur = gated[i];

    // Find overlapping detections (any label/type).
    const cluster: number[] = [i];
    for (let j = i + 1; j < gated.length; j++) {
      if (consumed[j]) continue;
      const other = gated[j];
      const ov = iou(cur.bbox, other.bbox);
      if (ov >= iouThresh) {
        // If types are compatible (either same, or one is text and it's clearly text),
        // treat as duplicate. If labels are similar, also duplicate.
        if (
          cur.type === other.type ||
          similarLabels(cur.label, other.label) ||
          ov >= 0.75
        ) {
          cluster.push(j);
        }
      }
    }

    // The winner is `cur` (already highest priority). Mark others consumed.
    for (const idx of cluster) consumed[idx] = true;

    // If cur is low-confidence but multiple detectors saw it → boost & keep.
    if (cur.confidence < minConf && cluster.length < 2) {
      rejected.push({ ...cur, reason: `low confidence ${cur.confidence.toFixed(2)}` });
      continue;
    }

    kept.push(cur);
    if (kept.length >= maxCount) break;
  }

  return { kept, rejected };
}
