// Compute per-frame CSS for a mask given the current playback time.
import type { RevealAnimation, Ease } from "./mask-templates";

export interface TimelineItem {
  regionId: string;
  startMs: number;
  durationMs: number;
  animation: RevealAnimation;
  ease: Ease;
}

const easeFns: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  "ease-out": (t) => 1 - Math.pow(1 - t, 3),
  "ease-in-out": (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};

export interface MaskStyle {
  opacity: number;
  transform: string;
  transformOrigin: string;
}

export function computeMaskStyle(item: TimelineItem, timeMs: number): MaskStyle {
  const raw = (timeMs - item.startMs) / Math.max(1, item.durationMs);
  const p = Math.max(0, Math.min(1, raw));
  const t = easeFns[item.ease](p);

  // Before start: mask fully covers.
  if (timeMs < item.startMs) {
    return { opacity: 1, transform: "scaleX(1) scaleY(1)", transformOrigin: "center" };
  }

  switch (item.animation) {
    case "instant":
      return { opacity: p >= 1 ? 0 : 1, transform: "none", transformOrigin: "center" };
    case "fade":
      return { opacity: 1 - t, transform: "none", transformOrigin: "center" };
    case "wipe-left":
      // Mask shrinks toward the right → content appears left→right.
      return { opacity: 1, transform: `scaleX(${1 - t})`, transformOrigin: "right center" };
    case "wipe-right":
      return { opacity: 1, transform: `scaleX(${1 - t})`, transformOrigin: "left center" };
    case "wipe-up":
      return { opacity: 1, transform: `scaleY(${1 - t})`, transformOrigin: "center bottom" };
    case "wipe-down":
      return { opacity: 1, transform: `scaleY(${1 - t})`, transformOrigin: "center top" };
  }
}

export function totalDuration(items: TimelineItem[]): number {
  return items.reduce((m, it) => Math.max(m, it.startMs + it.durationMs), 0);
}
