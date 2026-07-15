import type { Scene } from "@/components/VideoPlayer";
import { concatAudioClips, concatTwoWithGap } from "./audio-concat";
import { questionPostSpeechVisualMs, questionIntroGapMs } from "./question-scene-layout";
import { SCENE_HOLD_MS, TRANSITION_SFX_URL } from "./scene-transition";
import { probeAudioDurationMs } from "./audio-duration";

/** Default slide duration when stitching saved scenes (2s hold + ~1s transition). */
export const STITCH_TRANSITION_MS = 1000;

function sceneHoldForStitch(scene: Scene): number {
  if (scene.kind === "question") return questionPostSpeechVisualMs(scene);
  return scene.holdMs ?? SCENE_HOLD_MS;
}

async function resolveSceneAudioUrl(
  scene: Scene,
): Promise<{ url: string; introDurationMs?: number }> {
  if (scene.kind !== "question" || !scene.questionIntroAudioUrl) {
    return { url: scene.audioUrl };
  }
  const introDurationMs =
    scene.questionIntroDurationMs ??
    (await probeAudioDurationMs(scene.questionIntroAudioUrl)) ??
    undefined;
  const gapMs = questionIntroGapMs(scene);
  const composite = await concatTwoWithGap(
    scene.questionIntroAudioUrl,
    scene.audioUrl,
    gapMs,
  );
  return { url: composite.url, introDurationMs };
}

export interface StitchResult {
  scenes: Scene[];
  masterAudioUrl: string;
  durationMs: number;
  holdMs: number;
  transitionMs: number;
}

/**
 * Stitch per-scene TTS clips into one master track with hold + whoosh gaps.
 * Each scene gets startMs/endMs for continuous playback.
 */
export async function stitchProjectScenes(
  scenes: Scene[],
  opts?: { holdMs?: number; transitionMs?: number },
): Promise<StitchResult> {
  if (scenes.length === 0) {
    throw new Error("No scenes to stitch");
  }

  if (scenes.length === 1) {
    const s = scenes[0]!;
    const resolved = await resolveSceneAudioUrl(s);
    const probed = await probeAudioDurationMs(resolved.url);
    const dur = probed ?? s.durationMs ?? 4000;
    return {
      scenes: [{
        ...s,
        ...(resolved.introDurationMs != null
          ? { questionIntroDurationMs: resolved.introDurationMs }
          : {}),
        startMs: 0,
        endMs: dur,
        holdMs: sceneHoldForStitch(s),
        transitionMs: STITCH_TRANSITION_MS,
      }],
      masterAudioUrl: resolved.url,
      durationMs: dur,
      holdMs: sceneHoldForStitch(s),
      transitionMs: STITCH_TRANSITION_MS,
    };
  }

  const gapHolds =
    opts?.holdMs != null && !Array.isArray(opts.holdMs)
      ? scenes.slice(0, -1).map((s) =>
          s.kind === "question" ? sceneHoldForStitch(s) : (opts.holdMs as number),
        )
      : scenes.slice(0, -1).map((s) => sceneHoldForStitch(s));

  const resolved = await Promise.all(scenes.map((s) => resolveSceneAudioUrl(s)));
  const audioUrls = resolved.map((r) => r.url);

  const concat = await concatAudioClips(
    audioUrls,
    {
      holdMs: gapHolds,
      transitionMs: opts?.transitionMs ?? STITCH_TRANSITION_MS,
      transitionSfxUrl: TRANSITION_SFX_URL,
    },
  );

  const stitched: Scene[] = scenes.map((s, i) => {
    const w = concat.ranges[i];
    const introDurationMs = resolved[i]?.introDurationMs;
    return {
      ...s,
      ...(introDurationMs != null ? { questionIntroDurationMs: introDurationMs } : {}),
      masterAudioUrl: concat.url,
      startMs: w?.startMs ?? 0,
      endMs: w?.endMs ?? (w?.startMs ?? 0) + (s.durationMs ?? 4000),
      holdMs: sceneHoldForStitch(s),
      transitionMs: concat.transitionMs,
    };
  });

  return {
    scenes: stitched,
    masterAudioUrl: concat.url,
    durationMs: concat.durationMs,
    holdMs: concat.holdMs,
    transitionMs: concat.transitionMs,
  };
}
