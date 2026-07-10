// Scene background theming. "whiteboard" keeps the AI-generated hand-drawn
// background; "solid" and "gradient" replace it with a designer-picked color
// canvas and a padded white card that hosts the elements (see reference SS2).

export type SceneBackground =
  | { kind: "whiteboard" }
  | { kind: "solid"; color: string }
  | { kind: "gradient"; from: string; to: string; angle?: number }
  | { kind: "video"; url: string };

export const DEFAULT_BACKGROUND: SceneBackground = { kind: "whiteboard" };

export function backgroundToCss(bg: SceneBackground): string {
  if (bg.kind === "solid") return bg.color;
  if (bg.kind === "gradient") {
    const angle = bg.angle ?? 135;
    return `linear-gradient(${angle}deg, ${bg.from}, ${bg.to})`;
  }
  // whiteboard and video render their outer layer separately.
  return "#ffffff";
}

/** Inner white card inset when a custom background is in use. */
export const CARD_PADDING_FRAC = 0.04;

/**
 * Paint the scene background onto a canvas (used by the ffmpeg rasterizer).
 * For gradients we approximate the CSS `linear-gradient(angle, from, to)`.
 */
export function backgroundToCanvasFill(
  ctx: CanvasRenderingContext2D,
  bg: SceneBackground,
  W: number,
  H: number,
) {
  if (bg.kind === "solid") {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (bg.kind === "gradient") {
    const angle = ((bg.angle ?? 135) * Math.PI) / 180;
    const cx = W / 2, cy = H / 2;
    const dx = Math.sin(angle), dy = -Math.cos(angle);
    const half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
    const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
    g.addColorStop(0, bg.from);
    g.addColorStop(1, bg.to);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
}

