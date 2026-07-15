import {
  bboxArea,
  bboxIntersection,
  bboxIou,
  filterOutNestedBoxes,
  type NormBbox,
} from "./bbox-utils";

/** Saturated orange/amber frame pixels (common around the whiteboard area). */
function isColoredFramePixel(r: number, g: number, b: number): boolean {
  if (r < 150 || g < 60) return false;
  if (b > 160) return false;
  return r > g + 10 && g > b * 0.45;
}

/** White, off-white, or light pastel fill — content drawn on the canvas. */
function isCanvasInteriorPixel(r: number, g: number, b: number): boolean {
  if (isColoredFramePixel(r, g, b)) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 40) return false;
  if (max > 205 && max - min < 90) return true;
  if (min > 165 && max - min < 110) return true;
  return false;
}

function sampleColumn(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  step: number,
): { frame: number; interior: number; total: number } {
  let frame = 0;
  let interior = 0;
  let total = 0;
  for (let y = 0; y < height; y += step) {
    const i = (y * width + x) * 4;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    total++;
    if (isColoredFramePixel(r, g, b)) frame++;
    else if (isCanvasInteriorPixel(r, g, b)) interior++;
  }
  return { frame, interior, total };
}

function sampleRow(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  y: number,
  step: number,
): { frame: number; interior: number; total: number } {
  let frame = 0;
  let interior = 0;
  let total = 0;
  for (let x = 0; x < width; x += step) {
    const i = (y * width + x) * 4;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    total++;
    if (isColoredFramePixel(r, g, b)) frame++;
    else if (isCanvasInteriorPixel(r, g, b)) interior++;
  }
  return { frame, interior, total };
}

function edgeHasColoredFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): boolean {
  const step = Math.max(2, Math.floor(height / 120));
  const cols = [0, 1, 2, width - 3, width - 2, width - 1].filter(
    (x) => x >= 0 && x < width,
  );
  let hits = 0;
  for (const x of cols) {
    const { frame, total } = sampleColumn(data, width, height, x, step);
    if (total > 0 && frame / total > 0.22) hits++;
  }
  return hits >= 2;
}

function scanLeftInset(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  const step = Math.max(2, Math.floor(height / 100));
  const limit = Math.floor(width * 0.3);
  for (let x = 0; x < limit; x++) {
    const { frame, interior, total } = sampleColumn(data, width, height, x, step);
    if (total > 0 && interior / total > 0.18 && frame / total < 0.28) return x;
  }
  return 0;
}

function scanRightInset(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  const step = Math.max(2, Math.floor(height / 100));
  const start = width - 1;
  const limit = Math.floor(width * 0.3);
  for (let off = 0; off < limit; off++) {
    const x = start - off;
    const { frame, interior, total } = sampleColumn(data, width, height, x, step);
    if (total > 0 && interior / total > 0.18 && frame / total < 0.28) return x;
  }
  return width - 1;
}

function scanTopInset(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  const step = Math.max(2, Math.floor(width / 100));
  const limit = Math.floor(height * 0.3);
  for (let y = 0; y < limit; y++) {
    const { frame, interior, total } = sampleRow(data, width, height, y, step);
    if (total > 0 && interior / total > 0.18 && frame / total < 0.28) return y;
  }
  return 0;
}

function scanBottomInset(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  const step = Math.max(2, Math.floor(width / 100));
  const start = height - 1;
  const limit = Math.floor(height * 0.3);
  for (let off = 0; off < limit; off++) {
    const y = start - off;
    const { frame, interior, total } = sampleRow(data, width, height, y, step);
    if (total > 0 && interior / total > 0.18 && frame / total < 0.28) return y;
  }
  return height - 1;
}

/** Locate the white / light canvas interior in pixel space (full image if no frame). */
export function detectWhiteCanvasBbox(
  width: number,
  height: number,
  data: Uint8ClampedArray,
): NormBbox {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, w: 1, h: 1 };

  const hasFrame = edgeHasColoredFrame(data, width, height);
  let x0: number;
  let y0: number;
  let x1: number;
  let y1: number;

  if (hasFrame) {
    x0 = scanLeftInset(data, width, height);
    x1 = scanRightInset(data, width, height);
    y0 = scanTopInset(data, width, height);
    y1 = scanBottomInset(data, width, height);
  } else {
    x0 = 0;
    y0 = 0;
    x1 = width - 1;
    y1 = height - 1;
  }

  const padX = Math.max(1, Math.round(width * 0.008));
  const padY = Math.max(1, Math.round(height * 0.008));
  x0 = Math.min(width - 2, x0 + padX);
  y0 = Math.min(height - 2, y0 + padY);
  x1 = Math.max(x0 + 1, x1 - padX);
  y1 = Math.max(y0 + 1, y1 - padY);

  return {
    x: x0 / width,
    y: y0 / height,
    w: Math.max(0.05, (x1 - x0 + 1) / width),
    h: Math.max(0.05, (y1 - y0 + 1) / height),
  };
}

export function detectWhiteCanvasFromImage(img: HTMLImageElement): NormBbox {
  const width = img.naturalWidth || 1;
  const height = img.naturalHeight || 1;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { x: 0, y: 0, w: 1, h: 1 };
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  return detectWhiteCanvasBbox(width, height, data);
}

/** Keep boxes whose bulk lies on the white canvas (not the outer colored frame). */
export function filterBoxesOnWhiteCanvas<T extends { bbox: NormBbox }>(
  boxes: T[],
  canvas: NormBbox,
  minOverlap = 0.55,
): T[] {
  return boxes.filter((b) => {
    const area = bboxArea(b.bbox);
    if (area <= 0) return false;
    const overlap = bboxIntersection(b.bbox, canvas) / area;
    if (overlap < minOverlap) return false;
    const cx = b.bbox.x + b.bbox.w / 2;
    const cy = b.bbox.y + b.bbox.h / 2;
    return (
      cx >= canvas.x &&
      cy >= canvas.y &&
      cx <= canvas.x + canvas.w &&
      cy <= canvas.y + canvas.h
    );
  });
}

/** Drop false positives that span nearly the entire canvas (not a content card). */
export function filterOutCanvasFrameBoxes<T extends { bbox: NormBbox }>(
  boxes: T[],
  canvas: NormBbox,
): T[] {
  const canvasArea = bboxArea(canvas);
  return boxes.filter((b) => {
    const area = bboxArea(b.bbox);
    if (canvasArea <= 0) return true;
    if (area / canvasArea > 0.82 && bboxIou(b.bbox, canvas) > 0.72) return false;
    return true;
  });
}

/** Full reveal detection filter: white canvas scope → drop frame → outer boxes only. */
export function filterRevealBoxes<T extends { bbox: NormBbox }>(
  boxes: T[],
  canvas: NormBbox,
): T[] {
  const onCanvas = filterBoxesOnWhiteCanvas(boxes, canvas);
  const noFrame = filterOutCanvasFrameBoxes(onCanvas, canvas);
  return filterOutNestedBoxes(noFrame);
}
