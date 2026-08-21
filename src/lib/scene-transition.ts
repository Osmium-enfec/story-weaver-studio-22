import type { Scene } from "@/components/VideoPlayer";
import { revealSpeechDurationMs, speechProgressInScene } from "./reveal-schedule";
import { questionPostSpeechVisualMs, questionPreQuestionMs } from "./question-scene-layout";
import { templateCountdownDurationMs } from "@/lib/template-scene-canvas";
import {
  DEFAULT_TRANSITION_DURATION_MS,
  getTransitionSfx,
} from "@/lib/part-transition";

/** Spoken clip length within a stitched master window (excludes trailing hold + whoosh). */
function stitchedClipDurationMs(
  scene: Pick<
    Scene,
    | "startMs"
    | "endMs"
    | "masterAudioUrl"
    | "holdMs"
    | "transitionMs"
    | "kind"
    | "templateKind"
    | "templateCountdownSec"
    | "durationMs"
    | "questionMarkGapMs"
    | "questionMarkCountdownSec"
    | "questionMarkDurationMs"
  >,
  hasGap: boolean,
): number | null {
  if (scene.endMs == null || scene.startMs == null) return null;
  if (scene.endMs <= scene.startMs) return null;
  if (!scene.masterAudioUrl) return null;
  const windowMs = scene.endMs - scene.startMs;
  let clipMs: number;
  if (hasGap) {
    clipMs = Math.max(0, windowMs - sceneGapMs(scene));
  } else if (scene.kind === "question") {
    const hold = sceneHoldMs(scene);
    clipMs = hold > 0 ? Math.max(0, windowMs - hold) : windowMs;
  } else {
    clipMs = windowMs;
  }
  if (scene.kind === "template" && scene.templateKind === "countdown") {
    return templateCountdownDurationMs(scene.templateCountdownSec);
  }
  return clipMs;
}

/** Hold the finished scene on screen after narration ends. */
export const SCENE_HOLD_MS = 2000;

/** Bundled swoosh (default transition voice). */
export const TRANSITION_SFX_URL = getTransitionSfx("swoosh").url;

/** Visual slide duration between scenes (default 1s, matches swoosh). */
export const SCENE_TRANSITION_MS = DEFAULT_TRANSITION_DURATION_MS;

/** Default total silent gap between scene voice clips (hold + transition). */
export const SCENE_GAP_MS = SCENE_HOLD_MS + SCENE_TRANSITION_MS;

export function sceneHoldMs(
  scene: Pick<
    Scene,
    | "holdMs"
    | "kind"
    | "questionMarkGapMs"
    | "questionMarkCountdownSec"
    | "questionMarkDurationMs"
    | "outTransition"
  >,
): number {
  if (scene.kind === "question") return questionPostSpeechVisualMs(scene);
  return scene.holdMs ?? scene.outTransition?.holdMs ?? SCENE_HOLD_MS;
}

export function sceneTransitionMs(
  scene: Pick<Scene, "transitionMs" | "outTransition">,
): number {
  return scene.transitionMs ?? scene.outTransition?.durationMs ?? SCENE_TRANSITION_MS;
}

export function sceneGapMs(
  scene: Pick<
    Scene,
    | "holdMs"
    | "transitionMs"
    | "kind"
    | "questionMarkGapMs"
    | "questionMarkCountdownSec"
    | "questionMarkDurationMs"
    | "outTransition"
  >,
): number {
  return sceneHoldMs(scene) + sceneTransitionMs(scene);
}

export type SceneVisualPhase = "speech" | "hold" | "transition";

export interface MasterVisualState {
  phase: SceneVisualPhase;
  sceneIndex: number;
  /** 0..1 narration progress for the active scene's box reveals. */
  progress: number;
  /** Elapsed ms within the spoken clip (authoritative reveal clock). */
  elapsedSpeechMs: number;
  /** 0..1 during slide-left transition. */
  slideT: number;
  fromIndex: number;
  toIndex: number;
}

/** Resolve what to render at an absolute master-timeline position (ms). */
export function masterVisualAt(
  tMs: number,
  scenes: Scene[],
): MasterVisualState | null {
  if (scenes.length === 0) return null;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const startMs = scene.startMs ?? 0;
    const introPrefix = scene.kind === "question" ? questionPreQuestionMs(scene) : 0;
    const speechDur = revealSpeechDurationMs(scene);
    const holdMs = sceneHoldMs(scene);
    const transitionMs = Math.max(1, sceneTransitionMs(scene));
    const hasGap = i < scenes.length - 1;
    const stitchedClipMs = stitchedClipDurationMs(scene, hasGap);
    const spokenMs =
      stitchedClipMs ??
      introPrefix + speechDur;

    const speechEnd = startMs + spokenMs;
    const isLast = i === scenes.length - 1;
    const trailingQuestionHold = isLast && scene.kind === "question" && holdMs > 0;
    const visualEnd = hasGap
      ? (scene.endMs ?? speechEnd + holdMs + transitionMs)
      : trailingQuestionHold
        ? (scene.endMs ?? speechEnd + holdMs)
        : speechEnd;
    const transitionStart = hasGap ? visualEnd - transitionMs : visualEnd;

    if (tMs < startMs) continue;
    if (tMs >= visualEnd) continue;

    const elapsed = tMs - startMs;
    const questionElapsed = Math.max(0, elapsed - introPrefix);
    const speechProgressElapsed =
      stitchedClipMs != null ? Math.max(0, elapsed - introPrefix) : questionElapsed;

    if (tMs < speechEnd) {
      return {
        phase: "speech",
        sceneIndex: i,
        progress: speechProgressInScene(speechProgressElapsed, scene),
        elapsedSpeechMs: speechProgressElapsed,
        slideT: 0,
        fromIndex: i,
        toIndex: i,
      };
    }
    if (hasGap && tMs < transitionStart) {
      return {
        phase: "hold",
        sceneIndex: i,
        progress: 1,
        elapsedSpeechMs: speechDur,
        slideT: 0,
        fromIndex: i,
        toIndex: i,
      };
    }
    if (hasGap) {
      const slideT = Math.min(
        1,
        Math.max(0, (tMs - transitionStart) / transitionMs),
      );
      return {
        phase: "transition",
        sceneIndex: i,
        progress: 1,
        elapsedSpeechMs: speechDur,
        slideT,
        fromIndex: i,
        toIndex: i + 1,
      };
    }
    // Last/only question: stay on mark/countdown hold until visualEnd.
    return {
      phase: "hold",
      sceneIndex: i,
      progress: 1,
      elapsedSpeechMs: speechDur,
      slideT: 0,
      fromIndex: i,
      toIndex: i,
    };
  }

  const last = scenes.length - 1;
  const speechDur = revealSpeechDurationMs(scenes[last] ?? {});
  return {
    phase: "hold",
    sceneIndex: last,
    progress: 1,
    elapsedSpeechMs: speechDur,
    slideT: 0,
    fromIndex: last,
    toIndex: last,
  };
}

export function masterSceneIndexAt(tMs: number, scenes: Scene[]): number {
  return masterVisualAt(tMs, scenes)?.sceneIndex ?? 0;
}

/** Eased slide offset as fraction of container width (0 = centered, 1 = off-screen). */
export function slideOffset(t: number): number {
  const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return eased;
}
