/** Soft fade-in when a composed element first appears (preview + export). */
export const ELEMENT_APPEAR_FADE_MS = 900;

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Progress 0..1 through the appear fade, starting at `appearAt`. */
export function elementAppearProgress(
  progress: number,
  appearAt: number,
  durationMs: number,
  fadeMs = ELEMENT_APPEAR_FADE_MS,
): number {
  if (progress < appearAt) return 0;
  const window = Math.min(0.22, Math.max(0.05, fadeMs / Math.max(1, durationMs)));
  return Math.min(1, (progress - appearAt) / window);
}

/** Opacity for the appear animation — fade uses a gentle in-out curve. */
export function elementAppearOpacity(p: number, anim?: string | null): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (!anim || anim === "fade") return easeInOutCubic(p);
  return easeOutCubic(p);
}
