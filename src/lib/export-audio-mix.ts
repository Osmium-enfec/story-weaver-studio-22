import type { Scene } from "@/components/VideoPlayer";
import {
  CODE_TYPING_SFX,
  codeTypingSfxRangesMs,
  DEFAULT_CODE_TYPING_CPS,
  resolveCodeTypingBeats,
  typingSpeechEndProgress,
} from "./code-scene-sfx";
import { probeAudioDurationMs } from "./audio-duration";
import { encodeWav } from "./audio-slice";
import { getAudioContextCtor, getOfflineAudioContextCtor } from "./web-global";
import type { PartBgmConfig } from "./part-bgm";
import { resolvePartBgm } from "./part-bgm";
import { bgmMuteRangesMs } from "./common-intro-outro";
import { revealSpeechDurationMs } from "./reveal-schedule";
import { sceneGapMs } from "./scene-transition";
import {
  questionMarkGapMs,
  questionPreQuestionMs,
  questionPostSpeechVisualMs,
} from "./question-scene-layout";
import {
  recordingCameraZoomEvents,
  recordingCameraZoomSfxUrl,
} from "./recording-camera";
import { isExportNodeRuntime, resolveExportAssetUrl } from "./export-runtime";

const TYPING_VOLUME = 0.42;
const PLACEMENT_SFX_VOLUME = 0.85;
const CAMERA_ZOOM_SFX_VOLUME = 0.75;

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
  // Node fetch rejects relative paths; hybrid export sets baseUrl via export-runtime.
  const fetchUrl = isExportNodeRuntime() ? resolveExportAssetUrl(url) : url;
  let res: Response;
  try {
    res = await fetch(fetchUrl);
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

function typingRangesForScene(scene: Scene): { startMs: number; endMs: number }[] {
  if (scene.kind !== "code" || (scene.codeVariant ?? "typing") !== "typing") return [];
  const cps = scene.codeTypingCps ?? DEFAULT_CODE_TYPING_CPS;
  const beats = resolveCodeTypingBeats({
    beats: scene.codeTypingBeats,
    code: scene.code,
    output: scene.codeOutput,
    runDelayMs: scene.codeRunDelayMs,
    outputHoldMs: scene.codeOutputHoldMs,
  });
  if (beats.length > 0) return codeTypingSfxRangesMs(beats, cps);
  const code = scene.code ?? "";
  const endProgress = typingSpeechEndProgress(code, {
    cps: scene.codeTypingCps,
    durationMs: scene.durationMs,
  });
  if (endProgress <= 0) return [];
  const speechDur = revealSpeechDurationMs(scene);
  return [{ startMs: 0, endMs: speechDur * endProgress }];
}

/** Absolute master-timeline ranges where code typing SFX should play. */
export function computeTypingSegments(scenes: Scene[], masterMode: boolean): AudioSegment[] {
  const segments: AudioSegment[] = [];

  if (masterMode) {
    for (const scene of scenes) {
      const ranges = typingRangesForScene(scene);
      const startMs = scene.startMs ?? 0;
      for (const r of ranges) {
        segments.push({ startMs: startMs + r.startMs, endMs: startMs + r.endMs });
      }
    }
    return segments;
  }

  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const pre = scene.kind === "question" ? questionPreQuestionMs(scene) : 0;
    const speechDur = revealSpeechDurationMs(scene);
    for (const r of typingRangesForScene(scene)) {
      segments.push({
        startMs: acc + pre + r.startMs,
        endMs: acc + pre + r.endMs,
      });
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
    if (i < scenes.length - 1) {
      acc += sceneGapMs(scene);
    } else if (scene.kind === "question") {
      acc += questionPostSpeechVisualMs(scene);
    }
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

/** One-shot swoosh when a recording camera zoom starts. */
export function computeRecordingCameraSfxClips(
  scenes: Scene[],
  masterMode: boolean,
): TimedAudioClip[] {
  const clips: TimedAudioClip[] = [];

  const pushForScene = (scene: Scene, baseMs: number) => {
    if (scene.kind !== "recording") return;
    const url = recordingCameraZoomSfxUrl(scene.recordingCameraZoomSfx);
    if (!url) return;
    for (const ev of recordingCameraZoomEvents(scene.recordingCameraKeyframes)) {
      clips.push({
        startMs: baseMs + ev.startMs,
        url,
        volume: CAMERA_ZOOM_SFX_VOLUME,
      });
    }
  };

  if (masterMode) {
    for (const scene of scenes) {
      pushForScene(scene, scene.startMs ?? 0);
    }
    return clips;
  }

  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const pre = scene.kind === "question" ? questionPreQuestionMs(scene) : 0;
    const speechDur = revealSpeechDurationMs(scene);
    pushForScene(scene, acc + pre);
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
    computeRecordingCameraSfxClips(scenes, masterMode).length > 0 ||
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
    ...computeRecordingCameraSfxClips(scenes, masterMode),
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
  const AC = getAudioContextCtor();
  if (!AC) throw new Error("Web Audio not available");
  const Offline = getOfflineAudioContextCtor();
  if (!Offline) throw new Error("Web Audio not available");

  const probeCtx = new AC();
  const baseBuf = baseAudioUrl ? await decodeUrl(probeCtx, baseAudioUrl) : null;
  const sampleRate = baseBuf?.sampleRate ?? 44100;
  await probeCtx.close().catch(() => {});

  const offline = new Offline(2, Math.ceil(durationSec * sampleRate), sampleRate);

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
    const muteRanges = bgmMuteRangesMs(scenes);
    const vol = bgmConfig.volume;
    const mutedAtStart = muteRanges.some((r) => r.startMs <= 0 && r.endMs > 0);
    gain.gain.setValueAtTime(mutedAtStart ? 0 : vol, 0);
    for (const r of muteRanges) {
      const s = Math.max(0, r.startMs / 1000);
      const e = Math.min(durationSec, r.endMs / 1000);
      if (e <= s) continue;
      if (s > 0) {
        gain.gain.setValueAtTime(vol, Math.max(0, s - 0.001));
      }
      gain.gain.setValueAtTime(0, s);
      gain.gain.setValueAtTime(0, e);
      if (e < durationSec) {
        gain.gain.setValueAtTime(vol, Math.min(durationSec, e + 0.001));
      }
    }
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

/** Extend narration so ffmpeg -shortest does not cut video shorter than totalMs. */
export async function padAudioBlobToDuration(blob: Blob, totalMs: number): Promise<Blob> {
  if (totalMs <= 0) return blob;
  const url = URL.createObjectURL(blob);
  try {
    const currentMs = (await probeAudioDurationMs(url)) ?? 0;
    if (Math.abs(currentMs - totalMs) <= 20) return blob;

    const AC = getAudioContextCtor();
    if (!AC) return blob;
    const Offline = getOfflineAudioContextCtor();
    if (!Offline) return blob;
    const probeCtx = new AC();
    let sampleRate = 44100;
    try {
      const ab = await blob.arrayBuffer();
      const buf = await probeCtx.decodeAudioData(ab.slice(0));
      sampleRate = buf.sampleRate;
    } finally {
      await probeCtx.close().catch(() => {});
    }

    const targetSec = totalMs / 1000;
    const offline = new Offline(2, Math.ceil(targetSec * sampleRate), sampleRate);
    const srcAb = await blob.arrayBuffer();
    const srcBuf = await offline.decodeAudioData(srcAb.slice(0));
    const srcNode = offline.createBufferSource();
    srcNode.buffer = srcBuf;
    srcNode.connect(offline.destination);
    srcNode.start(0);
    const rendered = await offline.startRendering();
    const wav = encodeWav(rendered);
    return new Blob([wav], { type: "audio/wav" });
  } finally {
    URL.revokeObjectURL(url);
  }
}
