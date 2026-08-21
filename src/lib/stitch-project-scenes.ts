import type { Scene } from "@/components/VideoPlayer";
import { appendSilenceToAudio, concatAudioClips, concatTwoWithGap, trimTrailingSilenceFromUrl } from "./audio-concat";
import { questionPostSpeechVisualMs, questionIntroGapMs } from "./question-scene-layout";
import { SCENE_HOLD_MS, SCENE_TRANSITION_MS } from "./scene-transition";
import { probeAudioDurationMs } from "./audio-duration";
import { templateCountdownDurationMs } from "./template-scene-canvas";
import { recordingSceneDurationMs } from "./compose-scene";
import { layoutRecordingSceneAudio } from "./recording-audio-layout";
import {
  DEFAULT_PART_TRANSITION,
  getTransitionSfx,
  resolvePartTransition,
  syncGapTransitions,
  type PartTransitionConfig,
  type TransitionEffectId,
} from "./part-transition";

/** Slide duration when stitching (defaults to part transition / 2s). */
export const STITCH_TRANSITION_MS = SCENE_TRANSITION_MS;

function sceneHoldForStitch(scene: Scene): number {
  if (scene.kind === "question") return questionPostSpeechVisualMs(scene);
  return scene.holdMs ?? SCENE_HOLD_MS;
}

/** Skip trim for intentional silent beds / recordings. */
function shouldTrimTrailingSilence(scene: Scene): boolean {
  if (scene.silentNarration) return false;
  if (scene.kind === "recording") return false;
  if (scene.kind === "code" && !(scene.narrationText ?? "").trim()) return false;
  return true;
}

function sceneSpeechDurationForStitch(scene: Scene, probedMs: number | null): number {
  if (scene.kind === "template" && scene.templateKind === "countdown") {
    return templateCountdownDurationMs(scene.templateCountdownSec);
  }
  if (scene.kind === "recording") {
    const audioSource =
      scene.recordingAudioSourceDurationMs ??
      probedMs ??
      scene.durationMs ??
      0;
    return recordingSceneDurationMs({
      audioSegments: scene.recordingAudioSegments,
      audioTrimStartMs: scene.recordingAudioTrimStartMs ?? 0,
      audioTrimEndMs: scene.recordingAudioTrimEndMs ?? audioSource,
      audioDurationMs: audioSource,
      audioOffsetMs: scene.recordingAudioOffsetMs ?? 0,
      videoSegments: scene.recordingVideoSegments,
      trimStartMs: scene.recordingTrimStartMs ?? 0,
      trimEndMs: scene.recordingTrimEndMs ?? scene.recordingSourceDurationMs ?? 0,
      sourceDurationMs: scene.recordingSourceDurationMs ?? 0,
      videoOffsetMs: scene.recordingVideoOffsetMs ?? 0,
    });
  }
  // Prefer probed length (post-trim) so TTS trailing silence doesn't inflate the gap.
  return probedMs ?? scene.durationMs ?? 4000;
}

async function resolveSceneAudioUrl(
  scene: Scene,
): Promise<{
  url: string;
  introDurationMs?: number;
  /** Scene timeline speech duration (main narration for questions with intro). */
  durationMs?: number;
  /** Master-track clip length (intro + gap + main when composited). */
  clipDurationMs?: number;
}> {
  if (scene.kind === "recording") {
    const probed = await probeAudioDurationMs(scene.audioUrl);
    const audioSource = scene.recordingAudioSourceDurationMs ?? probed ?? scene.durationMs ?? 0;
    const speechDur = recordingSceneDurationMs({
      audioSegments: scene.recordingAudioSegments,
      audioTrimStartMs: scene.recordingAudioTrimStartMs ?? 0,
      audioTrimEndMs: scene.recordingAudioTrimEndMs ?? audioSource,
      audioDurationMs: audioSource,
      audioOffsetMs: scene.recordingAudioOffsetMs ?? 0,
      videoSegments: scene.recordingVideoSegments,
      trimStartMs: scene.recordingTrimStartMs ?? 0,
      trimEndMs: scene.recordingTrimEndMs ?? scene.recordingSourceDurationMs ?? 0,
      sourceDurationMs: scene.recordingSourceDurationMs ?? 0,
      videoOffsetMs: scene.recordingVideoOffsetMs ?? 0,
    });
    const laid = await layoutRecordingSceneAudio(scene.audioUrl, {
      segments: scene.recordingAudioSegments,
      trimStartMs: scene.recordingAudioTrimStartMs ?? 0,
      trimEndMs: scene.recordingAudioTrimEndMs ?? audioSource,
      offsetMs: scene.recordingAudioOffsetMs ?? 0,
      audioDurationMs: audioSource,
      sceneDurationMs: speechDur,
    });
    return { url: laid.url, durationMs: speechDur };
  }
  if (scene.kind !== "question" || !scene.questionIntroAudioUrl) {
    let url = scene.audioUrl;
    let durationMs = (await probeAudioDurationMs(url)) ?? scene.durationMs;
    if (shouldTrimTrailingSilence(scene)) {
      const trimmed = await trimTrailingSilenceFromUrl(url);
      url = trimmed.url;
      durationMs = trimmed.durationMs;
    }
    return { url, durationMs };
  }
  const introDurationMs =
    scene.questionIntroDurationMs ??
    (await probeAudioDurationMs(scene.questionIntroAudioUrl)) ??
    undefined;
  const gapMs = questionIntroGapMs(scene);
  let mainUrl = scene.audioUrl;
  if (shouldTrimTrailingSilence(scene)) {
    const trimmed = await trimTrailingSilenceFromUrl(mainUrl);
    mainUrl = trimmed.url;
  }
  const composite = await concatTwoWithGap(
    scene.questionIntroAudioUrl,
    mainUrl,
    gapMs,
  );
  return {
    url: composite.url,
    introDurationMs,
    /** Main narration only — timeline math must not double-count intro. */
    durationMs: composite.partBDurationMs,
    /** Full intro + gap + main length placed on the master track. */
    clipDurationMs: Math.round(composite.durationMs),
  };
}

export interface StitchResult {
  scenes: Scene[];
  masterAudioUrl: string;
  durationMs: number;
  holdMs: number;
  transitionMs: number;
}

export interface StitchOptions {
  holdMs?: number;
  transitionMs?: number;
  /** Default / legacy single transition (applied to every gap unless gaps provided). */
  transition?: PartTransitionConfig | null;
  /** Per-gap configs (length scenes.length - 1). Takes precedence. */
  gapTransitions?: PartTransitionConfig[] | null;
}

/**
 * Stitch per-scene TTS clips into one master track with hold + whoosh gaps.
 * Each scene gets startMs/endMs for continuous playback.
 * Last/only question scenes also get trailing mark/countdown silence (no whoosh).
 */
export async function stitchProjectScenes(
  scenes: Scene[],
  opts?: StitchOptions,
): Promise<StitchResult> {
  if (scenes.length === 0) {
    throw new Error("No scenes to stitch");
  }

  // Probe mark VO lengths so post-speech hold covers "Coding screen coming up in 3, 2, 1".
  const scenesWithMarkDur = await Promise.all(
    scenes.map(async (s) => {
      if (
        s.kind !== "question" ||
        !s.questionMarkAudioUrl ||
        (s.questionMarkDurationMs != null && s.questionMarkDurationMs > 0)
      ) {
        return s;
      }
      const ms = await probeAudioDurationMs(s.questionMarkAudioUrl);
      return ms != null ? { ...s, questionMarkDurationMs: ms } : s;
    }),
  );
  scenes = scenesWithMarkDur;

  const defaultTransition = resolvePartTransition(
    opts?.transition ?? {
      ...DEFAULT_PART_TRANSITION,
      durationMs: opts?.transitionMs ?? DEFAULT_PART_TRANSITION.durationMs,
    },
  );
  const gapTransitions = syncGapTransitions(
    opts?.gapTransitions ??
      scenes.slice(0, -1).map((s) =>
        resolvePartTransition(s.outTransition ?? defaultTransition),
      ),
    scenes.length,
    defaultTransition,
  );
  const transitionMsList = gapTransitions.map((g) => g.durationMs);
  const transitionVolumes = gapTransitions.map((g) => g.sfxVolume);
  // Single SFX asset for now (all presets share swoosh); volume still per-gap.
  const transitionSfxUrl = getTransitionSfx(
    gapTransitions[0]?.sfxId ?? defaultTransition.sfxId,
  ).url;
  const fallbackTransitionMs = opts?.transitionMs ?? defaultTransition.durationMs;

  if (scenes.length === 1) {
    const s = scenes[0]!;
    const resolved = await resolveSceneAudioUrl(s);
    const clipMs =
      resolved.clipDurationMs ??
      resolved.durationMs ??
      (await probeAudioDurationMs(resolved.url)) ??
      s.durationMs;
    const mainMs = resolved.durationMs ?? clipMs;
    const speechDur = sceneSpeechDurationForStitch(
      { ...s, durationMs: mainMs },
      mainMs,
    );
    const trailingHold = s.kind === "question" ? sceneHoldForStitch(s) : 0;
    // Master clip length: composited intro+main when present; otherwise speech target.
    const trackTargetMs = resolved.clipDurationMs ?? speechDur;
    let masterAudioUrl = resolved.url;
    let durationMs = clipMs;
    if (trackTargetMs > clipMs) {
      const padded = await appendSilenceToAudio(resolved.url, trackTargetMs - clipMs);
      masterAudioUrl = padded.url;
      durationMs = padded.durationMs;
    } else {
      durationMs = trackTargetMs;
    }
    if (trailingHold > 0) {
      const tailed = await appendSilenceToAudio(masterAudioUrl, trailingHold);
      masterAudioUrl = tailed.url;
      durationMs = tailed.durationMs;
    }
    return {
      scenes: [{
        ...s,
        ...(resolved.introDurationMs != null
          ? { questionIntroDurationMs: resolved.introDurationMs }
          : {}),
        durationMs: speechDur,
        startMs: 0,
        endMs: durationMs,
        holdMs: sceneHoldForStitch(s),
        transitionMs: fallbackTransitionMs,
        transitionEffect: defaultTransition.effect,
        masterAudioUrl,
      }],
      masterAudioUrl,
      durationMs,
      holdMs: sceneHoldForStitch(s),
      transitionMs: fallbackTransitionMs,
    };
  }

  const gapHolds = scenes.slice(0, -1).map((s, i) => {
    if (s.kind === "question") return sceneHoldForStitch(s);
    if (opts?.holdMs != null && !Array.isArray(opts.holdMs)) {
      return opts.holdMs as number;
    }
    return gapTransitions[i]?.holdMs ?? defaultTransition.holdMs;
  });

  const resolved = await Promise.all(scenes.map((s) => resolveSceneAudioUrl(s)));
  const speechDurs: number[] = [];
  const audioUrls = await Promise.all(
    resolved.map(async (r, i) => {
      const s = scenes[i]!;
      const clipMs =
        r.clipDurationMs ??
        r.durationMs ??
        (await probeAudioDurationMs(r.url)) ??
        s.durationMs;
      const mainMs = r.durationMs ?? clipMs;
      const speechDur = sceneSpeechDurationForStitch(
        { ...s, durationMs: mainMs },
        mainMs,
      );
      speechDurs[i] = speechDur;
      // Pad the master clip to the composited length (or speechDur when no intro).
      const trackTargetMs = r.clipDurationMs ?? speechDur;
      if (trackTargetMs > clipMs) {
        const padded = await appendSilenceToAudio(r.url, trackTargetMs - clipMs);
        return padded.url;
      }
      return r.url;
    }),
  );

  const concat = await concatAudioClips(
    audioUrls,
    {
      holdMs: gapHolds,
      transitionMs: transitionMsList,
      transitionSfxUrl,
      transitionSfxVolume: transitionVolumes,
    },
  );

  let masterAudioUrl = concat.url;
  let durationMs = concat.durationMs;
  const lastIdx = scenes.length - 1;
  const lastScene = scenes[lastIdx]!;
  const trailingHold =
    lastScene.kind === "question" ? sceneHoldForStitch(lastScene) : 0;

  const ranges = concat.ranges.map((r) => ({ ...r }));
  if (trailingHold > 0) {
    const tailed = await appendSilenceToAudio(concat.url, trailingHold);
    masterAudioUrl = tailed.url;
    durationMs = tailed.durationMs;
    const lastRange = ranges[lastIdx];
    if (lastRange) {
      lastRange.endMs = (lastRange.endMs ?? 0) + trailingHold;
    }
  }

  const stitched: Scene[] = scenes.map((s, i) => {
    const w = ranges[i];
    const introDurationMs = resolved[i]?.introDurationMs;
    const gap = i < lastIdx ? gapTransitions[i] : undefined;
    const holdMs =
      s.kind === "question"
        ? sceneHoldForStitch(s)
        : i < lastIdx
          ? (gap?.holdMs ?? gapHolds[i] ?? defaultTransition.holdMs)
          : sceneHoldForStitch(s);
    return {
      ...s,
      ...(introDurationMs != null ? { questionIntroDurationMs: introDurationMs } : {}),
      durationMs: speechDurs[i] ?? s.durationMs,
      masterAudioUrl,
      startMs: w?.startMs ?? 0,
      endMs: w?.endMs ?? (w?.startMs ?? 0) + (speechDurs[i] ?? s.durationMs ?? 4000),
      holdMs,
      transitionMs:
        i < lastIdx
          ? (concat.gapTransitionMs[i] ?? gap?.durationMs ?? fallbackTransitionMs)
          : fallbackTransitionMs,
      transitionEffect: gap?.effect ?? defaultTransition.effect,
      outTransition: gap ?? s.outTransition,
    };
  });

  return {
    scenes: stitched,
    masterAudioUrl,
    durationMs,
    holdMs: concat.holdMs,
    transitionMs: concat.transitionMs,
  };
}
