/** Inter-scene transition settings for a stitched part. */

export type TransitionEffectId = "slide-left";

export type TransitionSfxId = "swoosh";

export interface PartTransitionConfig {
  /**
   * Hold / wait after narration ends, before the slide starts (ms).
   * Default 2000 — the “2 sec wait” before swoosh.
   */
  holdMs: number;
  /** Visual slide duration between scenes (ms). Default 1000 to match swoosh. */
  durationMs: number;
  /** Visual swap effect. */
  effect: TransitionEffectId;
  /** Transition voice / SFX preset. */
  sfxId: TransitionSfxId;
  /** 0..1 gain for the transition SFX. */
  sfxVolume: number;
}

export interface TransitionEffectOption {
  id: TransitionEffectId;
  label: string;
  desc: string;
}

export interface TransitionSfxOption {
  id: TransitionSfxId;
  label: string;
  url: string;
  /** Nominal clip length (ms) — used for docs / future matching. */
  durationMs: number;
}

export const TRANSITION_EFFECT_OPTIONS: TransitionEffectOption[] = [
  {
    id: "slide-left",
    label: "Right to left swap",
    desc: "Outgoing slides left; next scene enters from the right",
  },
];

/** Bundled swoosh (~0.6s clip in a 1s preset slot; plays at start of the slide). */
export const TRANSITION_SFX_OPTIONS: TransitionSfxOption[] = [
  {
    id: "swoosh",
    label: "Swoosh",
    url: "/sfx/transition-swoosh.mp3",
    durationMs: 1000,
  },
];

/** Default wait after speech before the slide (2s). */
export const DEFAULT_TRANSITION_HOLD_MS = 2000;

/** Default visual slide: 1 second (matches swoosh). */
export const DEFAULT_TRANSITION_DURATION_MS = 1000;

/** Default SFX gain (matches previous hard-coded whoosh mix). */
export const DEFAULT_TRANSITION_SFX_VOLUME = 0.9;

export const DEFAULT_PART_TRANSITION: PartTransitionConfig = {
  holdMs: DEFAULT_TRANSITION_HOLD_MS,
  durationMs: DEFAULT_TRANSITION_DURATION_MS,
  effect: "slide-left",
  sfxId: "swoosh",
  sfxVolume: DEFAULT_TRANSITION_SFX_VOLUME,
};

export function getTransitionEffect(
  id: TransitionEffectId | string | undefined | null,
): TransitionEffectOption {
  return (
    TRANSITION_EFFECT_OPTIONS.find((e) => e.id === id) ??
    TRANSITION_EFFECT_OPTIONS[0]!
  );
}

export function getTransitionSfx(
  id: TransitionSfxId | string | undefined | null,
): TransitionSfxOption {
  return (
    TRANSITION_SFX_OPTIONS.find((s) => s.id === id) ?? TRANSITION_SFX_OPTIONS[0]!
  );
}

export function resolvePartTransition(
  raw: PartTransitionConfig | Partial<PartTransitionConfig> | undefined | null,
): PartTransitionConfig {
  const base = { ...DEFAULT_PART_TRANSITION, ...(raw ?? {}) };
  const effect = getTransitionEffect(base.effect).id;
  const sfx = getTransitionSfx(base.sfxId);
  const holdMs = Math.max(
    0,
    Math.min(15_000, Math.round(base.holdMs ?? DEFAULT_TRANSITION_HOLD_MS)),
  );
  const durationMs = Math.max(
    500,
    Math.min(10_000, Math.round(base.durationMs || DEFAULT_TRANSITION_DURATION_MS)),
  );
  return {
    holdMs,
    durationMs,
    effect,
    sfxId: sfx.id,
    sfxVolume: Math.max(0, Math.min(1, base.sfxVolume ?? DEFAULT_TRANSITION_SFX_VOLUME)),
  };
}

/** Pad/trim per-gap configs to match sceneCount - 1. */
export function syncGapTransitions(
  gaps: PartTransitionConfig[] | undefined | null,
  sceneCount: number,
  fallback: PartTransitionConfig = DEFAULT_PART_TRANSITION,
): PartTransitionConfig[] {
  const n = Math.max(0, sceneCount - 1);
  const resolvedFallback = resolvePartTransition(fallback);
  const src = gaps ?? [];
  return Array.from({ length: n }, (_, i) =>
    resolvePartTransition(src[i] ?? resolvedFallback),
  );
}
