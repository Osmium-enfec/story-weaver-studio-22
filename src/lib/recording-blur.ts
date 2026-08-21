/** One blur region in screen-recording source space (tracks through camera zoom). */

import { createExportCanvas } from "./export-runtime";

export interface RecordingBlurRegion {
  /** Left edge in source video, 0–1. */
  x: number;
  /** Top edge in source video, 0–1. */
  y: number;
  /** Width in source video, 0–1. */
  w: number;
  /** Height in source video, 0–1. */
  h: number;
  /** Blur amount 0–100. */
  strength: number;
}

export const DEFAULT_BLUR_STRENGTH = 50;
export const MIN_BLUR_STRENGTH = 0;
export const MAX_BLUR_STRENGTH = 100;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function normalizeRecordingBlurRegion(
  raw: RecordingBlurRegion | null | undefined,
): RecordingBlurRegion | null {
  if (!raw) return null;
  const w = clamp(raw.w, 0.01, 1);
  const h = clamp(raw.h, 0.01, 1);
  const x = clamp(raw.x, 0, 1 - w);
  const y = clamp(raw.y, 0, 1 - h);
  return {
    x,
    y,
    w,
    h,
    strength: clamp(Math.round(raw.strength), MIN_BLUR_STRENGTH, MAX_BLUR_STRENGTH),
  };
}

export function clampBlurStrength(n: number): number {
  return clamp(Math.round(n), MIN_BLUR_STRENGTH, MAX_BLUR_STRENGTH);
}

/** Pixel blur radius from strength % and a reference size (usually region short side). */
export function blurRadiusForStrength(strength: number, refPx: number): number {
  const s = clamp(strength, 0, 100) / 100;
  if (s <= 0) return 0;
  return Math.max(2, s * Math.max(8, refPx * 0.22));
}

export interface CameraDrawRects {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Map a source-normalized rect into the current camera view (dest pixels). */
export function sourceBlurRectToView(
  region: RecordingBlurRegion,
  sourceW: number,
  sourceH: number,
  rects: CameraDrawRects,
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

/** Map a point in the video container (same space as draw rects) → source 0–1. */
export function viewPointToSourceNorm(
  px: number,
  py: number,
  sourceW: number,
  sourceH: number,
  rects: CameraDrawRects,
): { x: number; y: number } | null {
  if (rects.dw <= 0 || rects.dh <= 0 || !sourceW || !sourceH) return null;
  // Clamp into the fitted frame so letterbox clicks still map to an edge.
  const u = clamp((px - rects.dx) / rects.dw, 0, 1);
  const v = clamp((py - rects.dy) / rects.dh, 0, 1);
  return {
    x: clamp((rects.sx + u * rects.sw) / sourceW, 0, 1),
    y: clamp((rects.sy + v * rects.sh) / sourceH, 0, 1),
  };
}

/** Build a normalized source rect from two view points (drag). */
export function viewDragToSourceBlurRegion(
  a: { x: number; y: number },
  b: { x: number; y: number },
  sourceW: number,
  sourceH: number,
  rects: CameraDrawRects,
  strength: number,
): RecordingBlurRegion | null {
  const p0 = viewPointToSourceNorm(a.x, a.y, sourceW, sourceH, rects);
  const p1 = viewPointToSourceNorm(b.x, b.y, sourceW, sourceH, rects);
  if (!p0 || !p1) return null;
  const x = Math.min(p0.x, p1.x);
  const y = Math.min(p0.y, p1.y);
  const w = Math.max(0.01, Math.abs(p1.x - p0.x));
  const h = Math.max(0.01, Math.abs(p1.y - p0.y));
  return normalizeRecordingBlurRegion({ x, y, w, h, strength });
}

/**
 * Draw a blurred patch of `src` into `ctx` at the current camera view.
 * Call after the main video crop has been drawn into the same dest.
 */
export function drawRecordingBlurRegion(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  rects: CameraDrawRects,
  region: RecordingBlurRegion,
): void {
  const normalized = normalizeRecordingBlurRegion(region);
  if (!normalized || normalized.strength <= 0) return;
  const view = sourceBlurRectToView(normalized, sourceW, sourceH, rects);
  if (!view || view.width < 1 || view.height < 1) return;

  const rx = normalized.x * sourceW;
  const ry = normalized.y * sourceH;
  const rw = Math.max(1, normalized.w * sourceW);
  const rh = Math.max(1, normalized.h * sourceH);
  const radius = blurRadiusForStrength(
    normalized.strength,
    Math.min(view.width, view.height),
  );
  if (radius <= 0) return;

  // Pad so blur soft edges aren't clipped harshly.
  const pad = Math.ceil(radius * 2);
  const tmp = createExportCanvas(
    Math.max(1, Math.ceil(view.width) + pad * 2),
    Math.max(1, Math.ceil(view.height) + pad * 2),
  ) as HTMLCanvasElement;
  tmp.width = Math.max(1, Math.ceil(view.width) + pad * 2);
  tmp.height = Math.max(1, Math.ceil(view.height) + pad * 2);
  const tctx = tmp.getContext("2d");
  if (!tctx) return;

  tctx.filter = `blur(${radius}px)`;
  tctx.drawImage(
    src,
    rx,
    ry,
    rw,
    rh,
    pad,
    pad,
    view.width,
    view.height,
  );
  tctx.filter = "none";

  ctx.save();
  ctx.beginPath();
  ctx.rect(view.left, view.top, view.width, view.height);
  ctx.clip();
  ctx.drawImage(tmp, view.left - pad, view.top - pad);
  ctx.restore();
}
