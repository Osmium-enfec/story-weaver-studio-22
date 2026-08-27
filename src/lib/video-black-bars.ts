/** Detect baked-in black/white matte padding around a video frame. */

import { createExportCanvas } from "./export-runtime";

export interface VideoContentCrop {
  /** Left edge in source pixels. */
  x: number;
  /** Top edge in source pixels. */
  y: number;
  /** Content width in source pixels. */
  w: number;
  /** Content height in source pixels. */
  h: number;
}

const BlackLumaThreshold = 16;
const RowColMatteFrac = 0.985;
const MaxScanFrac = 0.42;
const MinContentFrac = 0.35;
/** Ignore hairline edges — only real letterbox bars are cropped. */
const MinBarFrac = 0.012;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Only true black letterboxing counts as matte. White/light padding is left
 * alone: many screen recordings are light-themed edge to edge, and cropping
 * those zoomed into the content.
 */
function isMatte(data: Uint8ClampedArray, i: number): boolean {
  const r = data[i]!;
  const g = data[i + 1]!;
  const b = data[i + 2]!;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma <= BlackLumaThreshold;
}

function isMostlyMatteRow(
  data: Uint8ClampedArray,
  width: number,
  y: number,
  x0: number,
  x1: number,
): boolean {
  const row = y * width * 4;
  let matte = 0;
  const count = Math.max(1, x1 - x0 + 1);
  for (let x = x0; x <= x1; x++) {
    if (isMatte(data, row + x * 4)) matte += 1;
  }
  return matte / count >= RowColMatteFrac;
}

function isMostlyMatteCol(
  data: Uint8ClampedArray,
  width: number,
  _height: number,
  x: number,
  y0: number,
  y1: number,
): boolean {
  let matte = 0;
  const count = Math.max(1, y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) {
    if (isMatte(data, (y * width + x) * 4)) matte += 1;
  }
  return matte / count >= RowColMatteFrac;
}


/**
 * Find content inside black letterboxing or white canvas padding.
 * Columns are removed first, then rows are tested only over the remaining
 * width. This handles frames with white side padding and a black top bar.
 * Returns full-frame crop when no clear bars are found.
 */
export function detectVideoContentCropFromImageData(
  imageData: ImageData,
): VideoContentCrop {
  const { width: w, height: h, data } = imageData;
  if (w < 8 || h < 8) return { x: 0, y: 0, w, h };

  const maxY = Math.floor(h * MaxScanFrac);
  const maxX = Math.floor(w * MaxScanFrac);

  let left = 0;
  while (
    left < maxX &&
    isMostlyMatteCol(data, w, h, left, 0, h - 1)
  ) {
    left += 1;
  }
  let right = w - 1;
  while (
    right > w - 1 - maxX &&
    right > left &&
    isMostlyMatteCol(data, w, h, right, 0, h - 1)
  ) {
    right -= 1;
  }

  let top = 0;
  while (
    top < maxY &&
    isMostlyMatteRow(data, w, top, left, right)
  ) {
    top += 1;
  }
  let bottom = h - 1;
  while (
    bottom > h - 1 - maxY &&
    bottom > top &&
    isMostlyMatteRow(data, w, bottom, left, right)
  ) {
    bottom -= 1;
  }

  // Ignore sub-pixel / hairline edges: a clip without real black borders must
  // be shown untouched.
  const minBarX = Math.max(2, Math.round(w * MinBarFrac));
  const minBarY = Math.max(2, Math.round(h * MinBarFrac));
  if (left < minBarX) left = 0;
  if (top < minBarY) top = 0;
  if (right > w - 1 - minBarX) right = w - 1;
  if (bottom > h - 1 - minBarY) bottom = h - 1;

  // Real letterboxing is symmetric: bars appear on BOTH sides and are close in
  // size. A one-sided or lopsided dark band is UI chrome (VS Code title bar,
  // sidebar, terminal) and must never be cropped away.
  const leftBar = left;
  const rightBar = w - 1 - right;
  const topBar = top;
  const bottomBar = h - 1 - bottom;
  const lopsided = (a: number, b: number) =>
    a === 0 || b === 0 || Math.abs(a - b) > Math.max(a, b) * 0.35;
  if (lopsided(leftBar, rightBar)) {
    left = 0;
    right = w - 1;
  }
  if (lopsided(topBar, bottomBar)) {
    top = 0;
    bottom = h - 1;
  }

  if (left === 0 && top === 0 && right === w - 1 && bottom === h - 1) {
    return { x: 0, y: 0, w, h };
  }


  let cw = right - left + 1;
  let ch = bottom - top + 1;

  // Reject tiny / bogus crops (e.g. dark UI chrome false positives).
  if (cw < w * MinContentFrac || ch < h * MinContentFrac) {
    return { x: 0, y: 0, w, h };
  }


  // Slight inset only on detected edges so anti-aliased matte remnants vanish.
  const insetX = Math.min(4, Math.floor(cw * 0.01));
  const insetY = Math.min(4, Math.floor(ch * 0.01));
  if (left > 0) left = clamp(left + insetX, 0, w - 2);
  if (top > 0) top = clamp(top + insetY, 0, h - 2);
  if (right < w - 1) right = clamp(right - insetX, left + 1, w - 1);
  if (bottom < h - 1) bottom = clamp(bottom - insetY, top + 1, h - 1);
  cw = right - left + 1;
  ch = bottom - top + 1;

  return { x: left, y: top, w: cw, h: ch };
}

/** Sample a video/image frame onto a small canvas and detect content crop in source pixels. */
export function detectVideoContentCrop(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
): VideoContentCrop {
  if (!sourceW || !sourceH) return { x: 0, y: 0, w: sourceW || 0, h: sourceH || 0 };

  const maxSide = 320;
  const scale = Math.min(1, maxSide / Math.max(sourceW, sourceH));
  const sw = Math.max(8, Math.round(sourceW * scale));
  const sh = Math.max(8, Math.round(sourceH * scale));

  const canvas = createExportCanvas(sw, sh) as HTMLCanvasElement;
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { x: 0, y: 0, w: sourceW, h: sourceH };

  try {
    ctx.drawImage(source, 0, 0, sw, sh);
  } catch {
    return { x: 0, y: 0, w: sourceW, h: sourceH };
  }

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, sw, sh);
  } catch {
    return { x: 0, y: 0, w: sourceW, h: sourceH };
  }

  const sample = detectVideoContentCropFromImageData(imageData);
  const sx = sample.x / sw;
  const sy = sample.y / sh;
  const swN = sample.w / sw;
  const shN = sample.h / sh;

  return {
    x: Math.round(sx * sourceW),
    y: Math.round(sy * sourceH),
    w: Math.max(1, Math.round(swN * sourceW)),
    h: Math.max(1, Math.round(shN * sourceH)),
  };
}

export function isFullFrameCrop(
  crop: VideoContentCrop,
  sourceW: number,
  sourceH: number,
): boolean {
  return (
    crop.x <= 1 &&
    crop.y <= 1 &&
    crop.w >= sourceW - 2 &&
    crop.h >= sourceH - 2
  );
}

/** Cache detected crops per media URL (preview + export). */
const contentCropCache = new Map<string, VideoContentCrop>();

export function getCachedVideoContentCrop(key: string): VideoContentCrop | null {
  return contentCropCache.get(key) ?? null;
}

export function setCachedVideoContentCrop(key: string, crop: VideoContentCrop): void {
  contentCropCache.set(key, crop);
}

export function detectAndCacheVideoContentCrop(
  key: string,
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
): VideoContentCrop {
  const hit = contentCropCache.get(key);
  // A full-frame result may come from sampling before the first decoded frame.
  // Recheck it later instead of permanently poisoning this URL's cache.
  if (hit && !isFullFrameCrop(hit, sourceW, sourceH)) return hit;
  const crop = detectVideoContentCrop(source, sourceW, sourceH);
  if (!isFullFrameCrop(crop, sourceW, sourceH)) {
    contentCropCache.set(key, crop);
  }
  return crop;
}
