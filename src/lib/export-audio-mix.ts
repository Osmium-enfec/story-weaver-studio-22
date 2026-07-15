import type { Scene } from "@/components/VideoPlayer";
import { CODE_TYPING_SFX, typingSpeechEndProgress } from "./code-scene-sfx";
import { encodeWav } from "./audio-slice";
import type { PartBgmConfig } from "./part-bgm";
import { resolvePartBgm } from "./part-bgm";
import { revealSpeechDurationMs } from "./reveal-schedule";
import { sceneGapMs } from "./scene-transition";
import {
  questionMarkGapMs,
  questionPreQuestionMs,
} from "./question-scene-layout";

const TYPING_VOLUME = 0.42;
const PLACEMENT_SFX_VOLUME = 0.85;

export interface AudioSegment {
  startMs: number;
  endMs: number;
}

export interface TimedAudioClip {
  startMs: number;
  url: string;
  volume?: number;
  loop?: boolean;
}

async function decodeUrl(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    if (url.startsWith("blob:")) {
      throw new Error(
        "Stitched audio is no longer available. Re-stitch this part, save it again, then download.",
        { cause },
      );
    }
    throw cause;
  }
  if (!res.ok) {
    throw new Error(`Could not load audio (${res.status}). Re-stitch and save the part if this persists.`);
  }
  const ab = await res.arrayBuffer();
  return ctx.decodeAudioData(ab.slice(0));
}

/** Absolute master-timeline ranges where code typing SFX should play. */
export function computeTypingSegments(scenes: Scene[], masterMode: boolean): AudioSegment[] {
  const segments: AudioSegment[] = [];

  if (masterMode) {
    for (const scene of scenes) {
      if (scene.kind !== "code" || (scene.codeVariant ?? "typing") !== "typing") continue;
      const code = scene.code ?? "";
      const endProgress = typingSpeechEndProgress(code);
      if (endProgress <= 0) continue;
      const startMs = scene.startMs ?? 0;
      const speechDur = revealSpeechDurationMs(scene);
      segments.push({
        startMs: startMs,
        endMs: startMs + speechDur * endProgress,
      });
    }
    return segments;
  }

  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const pre = scene.kind === "question" ? questionPreQuestionMs(scene) : 0;
    const speechDur = revealSpeechDurationMs(scene);
    if (scene.kind === "code" && (scene.codeVariant ?? "typing") === "typing") {
      const endProgress = typingSpeechEndProgress(scene.code ?? "");
      if (endProgress > 0) {
        segments.push({
          startMs: acc + pre,
          endMs: acc + pre + speechDur * endProgress,
        });
      }
    }
    acc += pre + speechDur;
    if (i < scenes.length - 1) acc += sceneGapMs(scene);
  }
  return segments;
}

/** One-shot clips layered on the export timeline (intro / mark TTS). */
export function computeTimedAudioClips(scenes: Scene[], masterMode: boolean): TimedAudioClip[] {
  const clips: TimedAudioClip[] = [];

  if (masterMode) {
    for (const scene of scenes) {
      if (scene.kind !== "question") continue;
      const base = scene.startMs ?? 0;
      const pre = questionPreQuestionMs(scene);
      const speech = revealSpeechDurationMs(scene);
      if (scene.questionMarkAudioUrl) {
        clips.push({
          startMs: base + pre + speech + questionMarkGapMs(scene),
          url: scene.questionMarkAudioUrl,
        });
      }
    }
    return clips;
  }

  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const pre = scene.kind === "question" ? questionPreQuestionMs(scene) : 0;
    const speech = revealSpeechDurationMs(scene);
    if (scene.kind === "question") {
      if (scene.questionIntroAudioUrl) {
        clips.push({ startMs: acc, url: scene.questionIntroAudioUrl });
      }
      if (scene.questionMarkAudioUrl) {
        clips.push({
          startMs: acc + pre + speech + questionMarkGapMs(scene),
          url: scene.questionMarkAudioUrl,
        });
      }
    }
    acc += pre + speech;
    if (i < scenes.length - 1) acc += sceneGapMs(scene);
  }
  return clips;
}

/** One-shot tick/pop when a composed crop appears on screen. */
export function computePlacementSfxClips(scenes: Scene[], masterMode: boolean): TimedAudioClip[] {
  const clips: TimedAudioClip[] = [];

  if (masterMode) {
    for (const scene of scenes) {
      if (scene.kind !== "image") continue;
      const base = scene.startMs ?? 0;
      const speechDur = revealSpeechDurationMs(scene);
      for (const el of scene.elements ?? []) {
        if (!el.sfxUrl) continue;
        clips.push({
          startMs: base + el.appearAt * speechDur,
          url: el.sfxUrl,
          volume: PLACEMENT_SFX_VOLUME,
        });
      }
    }
    return clips;
  }

  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const pre = scene.kind === "question" ? questionPreQuestionMs(scene) : 0;
    const speechDur = revealSpeechDurationMs(scene);
    if (scene.kind === "image") {
      for (const el of scene.elements ?? []) {
        if (!el.sfxUrl) continue;
        clips.push({
          startMs: acc + pre + el.appearAt * speechDur,
          url: el.sfxUrl,
          volume: PLACEMENT_SFX_VOLUME,
        });
      }
    }
    acc += pre + speechDur;
    if (i < scenes.length - 1) acc += sceneGapMs(scene);
  }
  return clips;
}

export function exportNeedsTypingMix(scenes: Scene[]): boolean {
  return scenes.some(
    (s) =>
      s.kind === "code" &&
      (s.codeVariant ?? "typing") === "typing" &&
      typingSpeechEndProgress(s.code ?? "") > 0,
  );
}

export function exportNeedsAudioMix(
  scenes: Scene[],
  masterMode: boolean,
  bgm?: PartBgmConfig | null,
): boolean {
  return (
    exportNeedsTypingMix(scenes) ||
    computeTimedAudioClips(scenes, masterMode).length > 0 ||
    computePlacementSfxClips(scenes, masterMode).length > 0 ||
    resolvePartBgm(bgm) != null
  );
}

/**
 * Mix narration with SFX / question intro + mark TTS for export.
 * Preview plays typing, intro, and mark on separate DOM audio elements.
 */
export async function mixExportAudio(
  scenes: Scene[],
  baseAudioUrl: string | undefined,
  totalMs: number,
  masterMode: boolean,
  bgm?: PartBgmConfig | null,
): Promise<Blob> {
  const typingSegments = computeTypingSegments(scenes, masterMode);
  const timedClips = [
    ...computeTimedAudioClips(scenes, masterMode),
    ...computePlacementSfxClips(scenes, masterMode),
  ];
  const bgmConfig = resolvePartBgm(bgm);

  if (
    typingSegments.length === 0 &&
    timedClips.length === 0 &&
    !baseAudioUrl &&
    !bgmConfig
  ) {
    throw new Error("No audio to export");
  }

  const durationSec = Math.max(0.1, totalMs / 1000);
  const AC = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) throw new Error("Web Audio not available");

  const probeCtx = new AC();
  const baseBuf = baseAudioUrl ? await decodeUrl(probeCtx, baseAudioUrl) : null;
  const sampleRate = baseBuf?.sampleRate ?? 44100;
  await probeCtx.close().catch(() => {});

  const offline = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate);

  if (baseBuf) {
    const narration = offline.createBufferSource();
    narration.buffer = baseBuf;
    narration.connect(offline.destination);
    narration.start(0);
  }

  if (typingSegments.length > 0) {
    const typingBuf = await decodeUrl(offline, CODE_TYPING_SFX);
    const gain = offline.createGain();
    gain.gain.value = TYPING_VOLUME;
    gain.connect(offline.destination);

    for (const seg of typingSegments) {
      if (seg.endMs <= seg.startMs) continue;
      const src = offline.createBufferSource();
      src.buffer = typingBuf;
      src.loop = true;
      src.connect(gain);
      src.start(seg.startMs / 1000);
      src.stop(Math.min(durationSec, seg.endMs / 1000));
    }
  }

  if (bgmConfig) {
    const bgmBuf = await decodeUrl(offline, bgmConfig.url);
    const gain = offline.createGain();
    gain.gain.value = bgmConfig.volume;
    gain.connect(offline.destination);
    const src = offline.createBufferSource();
    src.buffer = bgmBuf;
    src.connect(gain);
    const playSec = Math.min(durationSec, bgmBuf.duration);
    if (playSec > 0) {
      src.start(0, 0, playSec);
    }
  }

  const clipCache = new Map<string, AudioBuffer>();
  for (const clip of timedClips) {
    if (!clipCache.has(clip.url)) {
      clipCache.set(clip.url, await decodeUrl(offline, clip.url));
    }
    const buf = clipCache.get(clip.url)!;
    const src = offline.createBufferSource();
    src.buffer = buf;
    src.loop = clip.loop ?? false;
    const gain = offline.createGain();
    gain.gain.value = clip.volume ?? 1;
    src.connect(gain);
    gain.connect(offline.destination);
    const startSec = Math.max(0, clip.startMs / 1000);
    if (startSec < durationSec) {
      src.start(startSec);
    }
  }

  const rendered = await offline.startRendering();
  const wav = encodeWav(rendered);
  return new Blob([wav], { type: "audio/wav" });
}
