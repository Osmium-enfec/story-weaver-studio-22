import type { NormBbox } from "./bbox-utils";

/** GPT vision sometimes returns 0..100 or 0..1000 instead of 0..1. */
function rescalePercentLike(a: number, b: number, c: number, d: number): [number, number, number, number] {
  const maxVal = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (maxVal > 1.05 && maxVal <= 100.5) {
    return [a / 100, b / 100, c / 100, d / 100];
  }
  if (maxVal > 100.5 && maxVal <= 1000.5) {
    return [a / 1000, b / 1000, c / 1000, d / 1000];
  }
  return [a, b, c, d];
}

/** Parse [x1,y1,x2,y2] (pixel or normalized) into 0..1 {x,y,w,h}. */
export function normalizeDetectorBbox(
  raw: number[],
  imgW?: number,
  imgH?: number,
): NormBbox | null {
  if (raw.length < 4 || raw.some((n) => !Number.isFinite(n))) return null;
  let [x1, y1, x2, y2] = rescalePercentLike(...raw.map(Number) as [number, number, number, number]);

  const looksPixel = Math.max(x1, y1, x2, y2) > 1.05;
  if (looksPixel) {
    const w = imgW && imgW > 0 ? imgW : 1536;
    const h = imgH && imgH > 0 ? imgH : 1024;
    x1 /= w;
    x2 /= w;
    y1 /= h;
    y2 /= h;
  }

  const nx = Math.max(0, Math.min(1, Math.min(x1, x2)));
  const ny = Math.max(0, Math.min(1, Math.min(y1, y2)));
  const nw = Math.max(0, Math.min(1 - nx, Math.abs(x2 - x1)));
  const nh = Math.max(0, Math.min(1 - ny, Math.abs(y2 - y1)));
  if (nw < 0.02 || nh < 0.02) return null;
  if (nw * nh > 0.92) return null;
  return { x: nx, y: ny, w: nw, h: nh };
}
