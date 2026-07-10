// Fixed grid layouts for image scenes. The planner returns 1–6 elements per
// scene; the client + rasterizer look up positions here based on the count so
// every scene lands in one of a handful of clean, predictable arrangements.
//
// Coordinates are fractions of the INNER card (the white rounded area when a
// custom background is used, or the full canvas on whiteboard mode).
//   x, y = center of the element (0 = left/top, 1 = right/bottom)
//   w    = width as a fraction of the canvas width
//
// The vertical band 0.00 – 0.24 is reserved for the title strip and
// 0.90 – 1.00 for breathing room, so element y stays within 0.30 – 0.86.

export type ElementPos = { x: number; y: number; w: number };

export const TITLE_BAND: { y: number; h: number } = { y: 0.02, h: 0.20 };

export const LAYOUTS: Record<number, ElementPos[]> = {
  1: [{ x: 0.5, y: 0.55, w: 0.38 }],
  // 50/50
  2: [
    { x: 0.28, y: 0.55, w: 0.28 },
    { x: 0.72, y: 0.55, w: 0.28 },
  ],
  // 33/33/33
  3: [
    { x: 0.20, y: 0.55, w: 0.20 },
    { x: 0.50, y: 0.55, w: 0.20 },
    { x: 0.80, y: 0.55, w: 0.20 },
  ],
  // 2x2 grid
  4: [
    { x: 0.28, y: 0.42, w: 0.18 },
    { x: 0.72, y: 0.42, w: 0.18 },
    { x: 0.28, y: 0.72, w: 0.18 },
    { x: 0.72, y: 0.72, w: 0.18 },
  ],
  // 3 top / 2 bottom
  5: [
    { x: 0.22, y: 0.42, w: 0.16 },
    { x: 0.50, y: 0.42, w: 0.16 },
    { x: 0.78, y: 0.42, w: 0.16 },
    { x: 0.34, y: 0.72, w: 0.17 },
    { x: 0.66, y: 0.72, w: 0.17 },
  ],
  // 3x2 grid
  6: [
    { x: 0.20, y: 0.42, w: 0.16 },
    { x: 0.50, y: 0.42, w: 0.16 },
    { x: 0.80, y: 0.42, w: 0.16 },
    { x: 0.20, y: 0.72, w: 0.16 },
    { x: 0.50, y: 0.72, w: 0.16 },
    { x: 0.80, y: 0.72, w: 0.16 },
  ],
};

export function layoutFor(count: number): ElementPos[] {
  if (count <= 0) return [];
  if (count >= 6) return LAYOUTS[6];
  return LAYOUTS[count] ?? LAYOUTS[1];
}
