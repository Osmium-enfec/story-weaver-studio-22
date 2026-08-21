/** Timed hand-drawn rectangle highlight on screen recordings (source space 0–1). */

export interface RecordingHighlight {
  id: string;
  /** Left edge in source video, 0–1. */
  x: number;
  /** Top edge in source video, 0–1. */
  y: number;
  /** Width in source video, 0–1. */
  w: number;
  /** Height in source video, 0–1. */
  h: number;
  /** Stroke color (#RRGGBB). */
  color: string;
  /** Scene clock when the draw animation starts (ms). */
  atMs: number;
  /** How long the stroke takes to draw start→end (ms). */
  drawMs: number;
}

export const DEFAULT_HIGHLIGHT_COLOR = "#ef4444";
/** Full highlight lifetime at the playhead (draw + fade). */
export const HIGHLIGHT_TOTAL_MS = 1000;
/** Stroke draws for this long, then fades for the rest of HIGHLIGHT_TOTAL_MS. */
export const DEFAULT_HIGHLIGHT_DRAW_MS = 600;
export const HIGHLIGHT_DISAPPEAR_MS = HIGHLIGHT_TOTAL_MS - DEFAULT_HIGHLIGHT_DRAW_MS;
export const MIN_HIGHLIGHT_DRAW_MS = DEFAULT_HIGHLIGHT_DRAW_MS;
export const MAX_HIGHLIGHT_DRAW_MS = DEFAULT_HIGHLIGHT_DRAW_MS;

export const HIGHLIGHT_COLOR_PRESETS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ffffff",
  "#111827",
] as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function newRecordingHighlightId(): string {
  return `hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function clampHighlightDrawMs(ms: number): number {
  return clamp(Math.round(ms), MIN_HIGHLIGHT_DRAW_MS, MAX_HIGHLIGHT_DRAW_MS);
}

export function normalizeHighlightColor(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1]!;
    const g = s[2]!;
    const b = s[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return DEFAULT_HIGHLIGHT_COLOR;
}

export function normalizeRecordingHighlight(
  raw: RecordingHighlight | null | undefined,
): RecordingHighlight | null {
  if (!raw) return null;
  const w = clamp(raw.w, 0.01, 1);
  const h = clamp(raw.h, 0.01, 1);
  return {
    id: raw.id?.trim() || newRecordingHighlightId(),
    x: clamp(raw.x, 0, 1 - w),
    y: clamp(raw.y, 0, 1 - h),
    w,
    h,
    color: normalizeHighlightColor(raw.color),
    atMs: Math.max(0, Math.round(raw.atMs)),
    // Fixed 1s highlight: stroke then fade; ignore legacy per-item draw durations.
    drawMs: DEFAULT_HIGHLIGHT_DRAW_MS,
  };
}

export function normalizeRecordingHighlights(
  raw: RecordingHighlight[] | null | undefined,
): RecordingHighlight[] {
  if (!raw?.length) return [];
  return raw
    .map((h) => normalizeRecordingHighlight(h))
    .filter((h): h is RecordingHighlight => !!h)
    .sort((a, b) => a.atMs - b.atMs);
}

export interface HighlightAnimState {
  /** 0 = not started drawing, 1 = fully drawn. */
  strokeProgress: number;
  /** 1 = fully visible, 0 = gone. */
  opacity: number;
  /** True while any part of the animation is active. */
  active: boolean;
}

/** Animation at scene clock: draw stroke, then fade — total HIGHLIGHT_TOTAL_MS. */
export function highlightAnimAtMs(
  highlight: RecordingHighlight,
  clockMs: number,
): HighlightAnimState {
  const h = normalizeRecordingHighlight(highlight);
  if (!h) return { strokeProgress: 0, opacity: 0, active: false };
  const local = clockMs - h.atMs;
  if (local < 0 || local > HIGHLIGHT_TOTAL_MS) {
    return { strokeProgress: 0, opacity: 0, active: false };
  }
  if (local <= DEFAULT_HIGHLIGHT_DRAW_MS) {
    return {
      strokeProgress: clamp(local / Math.max(1, DEFAULT_HIGHLIGHT_DRAW_MS), 0, 1),
      opacity: 1,
      active: true,
    };
  }
  const fade = (local - DEFAULT_HIGHLIGHT_DRAW_MS) / HIGHLIGHT_DISAPPEAR_MS;
  return {
    strokeProgress: 1,
    opacity: clamp(1 - fade, 0, 1),
    active: true,
  };
}

export function highlightTotalDurationMs(_highlight?: RecordingHighlight): number {
  return HIGHLIGHT_TOTAL_MS;
}

/** Deterministic −1…1 noise from id (stable per highlight). */
function n01(seed: string, i: number): number {
  let h = 2166136261;
  for (let c = 0; c < seed.length; c++) h = Math.imul(h ^ seed.charCodeAt(c), 16777619);
  h = Math.imul(h ^ (i + 1) * 2654435761, 16777619);
  return ((h >>> 0) % 10000) / 5000 - 1;
}

/** Marker-like stroke width for the doodle frame. */
export function highlightStrokeWidth(width: number, height: number): number {
  return Math.max(3.2, Math.min(width, height) * 0.038);
}

/**
 * Hand-drawn rounded rectangle matching a marker doodle:
 * soft bows, large rounded corners, open path ending with a tapered
 * overshoot past the bottom-right (like the reference sketch).
 */
export function handDrawnRectPathD(
  left: number,
  top: number,
  width: number,
  height: number,
  seed: string,
): string {
  const pad = Math.max(2.5, Math.min(width, height) * 0.03);
  const x0 = left + pad;
  const y0 = top + pad;
  const x1 = left + width - pad;
  const y1 = top + height - pad;
  const w = Math.max(8, x1 - x0);
  const h = Math.max(8, y1 - y0);
  // Large soft corners like the reference doodle
  const r = Math.min(w, h) * (0.2 + 0.04 * n01(seed, 0));
  const bow = Math.min(w, h) * 0.028;
  const overshoot = Math.min(w * 0.1, Math.max(12, r * 0.95));

  const topBow = bow * (0.55 + 0.45 * n01(seed, 1));
  const rightBow = bow * (0.45 + 0.45 * n01(seed, 2));
  const bottomBow = bow * (0.65 + 0.35 * n01(seed, 3));
  const leftBow = bow * (0.5 + 0.4 * n01(seed, 4));

  // Corner control length for circular-ish cubic arcs (~k * r)
  const k = 0.5522847498;
  const kr = k * r;

  // Start on the lower right edge (just above the bottom corner), go
  // counter-clockwise, finish along the bottom past the right edge.
  const startY = y1 - r * (0.75 + 0.2 * Math.abs(n01(seed, 5)));

  const f = (n: number) => n.toFixed(2);

  // Midpoints of each straight-ish side (with outward bow)
  const midRight = { x: x1 + rightBow, y: (y0 + r + startY) / 2 };
  const midTop = { x: (x0 + x1) / 2, y: y0 - topBow };
  const midLeft = { x: x0 - leftBow, y: (y0 + y1) / 2 };
  const midBottom = { x: (x0 + x1) / 2, y: y1 + bottomBow };

  // Path: up right → TR → left top → TL → down left → BL → right bottom → tip
  let d = `M ${f(x1)} ${f(startY)}`;

  // Up the right side into top-right corner start
  d += ` C ${f(x1 + rightBow * 0.35)} ${f(startY - (startY - y0 - r) * 0.35)}, ${f(midRight.x)} ${f(midRight.y)}, ${f(x1)} ${f(y0 + r)}`;
  // TR corner
  d += ` C ${f(x1)} ${f(y0 + r - kr)}, ${f(x1 - r + kr)} ${f(y0)}, ${f(x1 - r)} ${f(y0)}`;
  // Top edge
  d += ` C ${f(x1 - r - w * 0.12)} ${f(y0 - topBow * 0.4)}, ${f(midTop.x + w * 0.08)} ${f(midTop.y)}, ${f(midTop.x)} ${f(midTop.y)}`;
  d += ` C ${f(midTop.x - w * 0.1)} ${f(midTop.y)}, ${f(x0 + r + w * 0.1)} ${f(y0 - topBow * 0.35)}, ${f(x0 + r)} ${f(y0)}`;
  // TL corner
  d += ` C ${f(x0 + r - kr)} ${f(y0)}, ${f(x0)} ${f(y0 + r - kr)}, ${f(x0)} ${f(y0 + r)}`;
  // Left edge
  d += ` C ${f(x0 - leftBow * 0.4)} ${f(y0 + r + h * 0.15)}, ${f(midLeft.x)} ${f(midLeft.y)}, ${f(x0)} ${f(y1 - r)}`;
  // BL corner
  d += ` C ${f(x0)} ${f(y1 - r + kr)}, ${f(x0 + r - kr)} ${f(y1)}, ${f(x0 + r)} ${f(y1)}`;
  // Bottom edge toward the right, then overshoot past the corner (open — no Z)
  d += ` C ${f(x0 + r + w * 0.18)} ${f(y1 + bottomBow * 0.45)}, ${f(midBottom.x - w * 0.05)} ${f(midBottom.y)}, ${f(midBottom.x)} ${f(midBottom.y)}`;
  d += ` C ${f(midBottom.x + w * 0.18)} ${f(midBottom.y)}, ${f(x1 - r * 0.2)} ${f(y1 + bottomBow * 0.25)}, ${f(x1 + overshoot * 0.35)} ${f(y1 + n01(seed, 6) * 1.2)}`;
  // Fine tip past the bottom-right
  d += ` C ${f(x1 + overshoot * 0.65)} ${f(y1 + n01(seed, 7) * 0.8)}, ${f(x1 + overshoot * 0.9)} ${f(y1)}, ${f(x1 + overshoot)} ${f(y1 - 0.5 + n01(seed, 8) * 0.6)}`;

  return d;
}

/** Approximate path length for canvas dash progress (open rounded rect + tip). */
export function handDrawnRectPathLength(width: number, height: number): number {
  const pad = Math.max(2.5, Math.min(width, height) * 0.03);
  const w = Math.max(8, width - pad * 2);
  const h = Math.max(8, height - pad * 2);
  const r = Math.min(w, h) * 0.22;
  // Perimeter of rounded rect + overshoot tip
  return 2 * (w + h - 2 * r) + 2 * Math.PI * r * 0.5 + Math.min(w * 0.1, 24);
}

export interface CameraDrawRectsLike {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Map highlight rect into current camera view (same as blur). */
export function sourceHighlightRectToView(
  region: Pick<RecordingHighlight, "x" | "y" | "w" | "h">,
  sourceW: number,
  sourceH: number,
  rects: CameraDrawRectsLike,
): { left: number; top: number; width: number; height: number } | null {
  if (!sourceW || !sourceH) return null;
  const rx = region.x * sourceW;
  const ry = region.y * sourceH;
  const rw = region.w * sourceW;
  const rh = region.h * sourceH;
  const ix0 = Math.max(rx, rects.sx);
  const iy0 = Math.max(ry, rects.sy);
  const ix1 = Math.min(rx + rw, rects.sx + rects.sw);
  const iy1 = Math.min(ry + rh, rects.sy + rects.sh);
  if (ix1 <= ix0 || iy1 <= iy0) return null;
  return {
    left: rects.dx + ((ix0 - rects.sx) / rects.sw) * rects.dw,
    top: rects.dy + ((iy0 - rects.sy) / rects.sh) * rects.dh,
    width: ((ix1 - ix0) / rects.sw) * rects.dw,
    height: ((iy1 - iy0) / rects.sh) * rects.dh,
  };
}

/** Draw highlight stroke into a canvas context (export / bake). */
export function drawRecordingHighlight(
  ctx: CanvasRenderingContext2D,
  highlight: RecordingHighlight,
  sourceW: number,
  sourceH: number,
  rects: CameraDrawRectsLike,
  clockMs: number,
): void {
  const h = normalizeRecordingHighlight(highlight);
  if (!h) return;
  const anim = highlightAnimAtMs(h, clockMs);
  if (!anim.active || anim.opacity <= 0.01) return;
  const view = sourceHighlightRectToView(h, sourceW, sourceH, rects);
  if (!view || view.width < 2 || view.height < 2) return;

  const d = handDrawnRectPathD(view.left, view.top, view.width, view.height, h.id);
  const path = new Path2D(d);
  const strokeW = highlightStrokeWidth(view.width, view.height);
  const peri = handDrawnRectPathLength(view.width, view.height);
  const drawn = peri * anim.strokeProgress;

  ctx.save();
  ctx.globalAlpha = anim.opacity;
  ctx.strokeStyle = h.color;
  ctx.lineWidth = strokeW;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([drawn, Math.max(0, peri - drawn + 1)]);
  ctx.lineDashOffset = 0;
  ctx.stroke(path);
  ctx.restore();
}
