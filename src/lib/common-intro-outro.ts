import type { Scene } from "@/components/VideoPlayer";
import {
  composeRecordingDraftToScene,
  emptyComposeRecordingDraft,
  type ComposeRecordingDraft,
} from "@/lib/compose-scene";
import { sceneGapMs } from "@/lib/scene-transition";

/** Brand bumper for Script Intro scenes. */
export const COMMON_INTRO_VIDEO_URL = commonIntroAsset.url;
export const COMMON_INTRO_AUDIO_URL = "/common-intro.mp3";
/** Matches the brand open video (~12.22s). */
export const COMMON_INTRO_DURATION_MS = 12_217;

/** Brand bumper for Script Outro scenes. */
export const COMMON_OUTRO_VIDEO_URL = commonOutroAsset.url;
export const COMMON_OUTRO_AUDIO_URL = "/common-outro.mp3";
export const COMMON_OUTRO_DURATION_MS = 12_221;

/** @deprecated Legacy shared bumper — still recognized for existing projects. */
export const COMMON_INTRO_OUTRO_VIDEO_URL = commonIntroOutroAsset.url;

/** Legacy `/public` paths kept so already-saved projects still resolve. */
const LEGACY_BUMPER_URLS = [
  "/common-intro.mp4",
  "/common-outro.mp4",
  "/common-intro-outro.mp4",
];
/** @deprecated */
export const COMMON_INTRO_OUTRO_AUDIO_URL = "/common-intro-outro.mp3";
/** @deprecated Prefer COMMON_INTRO_DURATION_MS / COMMON_OUTRO_DURATION_MS. */
export const COMMON_INTRO_OUTRO_DURATION_MS = COMMON_INTRO_DURATION_MS;

export type CommonBumperLabel = "Intro" | "Outro";

export function commonBumperVideoUrl(label: CommonBumperLabel): string {
  return label === "Outro" ? COMMON_OUTRO_VIDEO_URL : COMMON_INTRO_VIDEO_URL;
}

export function commonBumperAudioUrl(label: CommonBumperLabel): string {
  return label === "Outro" ? COMMON_OUTRO_AUDIO_URL : COMMON_INTRO_AUDIO_URL;
}

export function commonBumperDurationMs(label: CommonBumperLabel): number {
  return label === "Outro" ? COMMON_OUTRO_DURATION_MS : COMMON_INTRO_DURATION_MS;
}

export function isCommonIntroOutroMediaUrl(url: string | null | undefined): boolean {
  return (
    url === COMMON_INTRO_VIDEO_URL ||
    url === COMMON_OUTRO_VIDEO_URL ||
    url === COMMON_INTRO_OUTRO_VIDEO_URL
  );
}

/** True when this timeline scene is a shared brand bumper (already has music). */
export function isCommonIntroOutroScene(
  scene: Pick<Scene, "mediaUrl">,
): boolean {
  return isCommonIntroOutroMediaUrl(scene.mediaUrl);
}

/**
 * Absolute timeline ranges where part BGM must stay silent — the bumper
 * already carries its own music bed.
 */
export function bgmMuteRangesMs(scenes: Scene[]): { startMs: number; endMs: number }[] {
  const ranges: { startMs: number; endMs: number }[] = [];
  const masterMode = scenes.some(
    (s) => s.masterAudioUrl != null && s.startMs != null,
  );

  if (masterMode) {
    for (const scene of scenes) {
      if (!isCommonIntroOutroScene(scene)) continue;
      const startMs = scene.startMs ?? 0;
      const fallbackMs =
        scene.mediaUrl === COMMON_OUTRO_VIDEO_URL
          ? COMMON_OUTRO_DURATION_MS
          : COMMON_INTRO_DURATION_MS;
      const clipMs = Math.max(0, scene.durationMs ?? fallbackMs);
      const endMs = startMs + clipMs;
      if (endMs > startMs) ranges.push({ startMs, endMs });
    }
    return ranges;
  }

  // Match VideoPlayer per-scene timeline (duration + inter-scene gaps).
  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const dur = Math.max(0, scene.durationMs ?? 0);
    if (isCommonIntroOutroScene(scene) && dur > 0) {
      ranges.push({ startMs: acc, endMs: acc + dur });
    }
    acc += dur;
    if (i < scenes.length - 1) acc += sceneGapMs(scene);
  }
  return ranges;
}

export function bgmMutedAtMs(
  ranges: Array<{ startMs: number; endMs: number }>,
  tMs: number,
): boolean {
  return ranges.some((r) => tMs >= r.startMs && tMs < r.endMs);
}

/** Ready clip draft — no upload / TTS / extract step. */
export function commonIntroOutroRecordingDraft(
  label: CommonBumperLabel = "Intro",
): ComposeRecordingDraft {
  const ms = commonBumperDurationMs(label);
  const videoUrl = commonBumperVideoUrl(label);
  const audioUrl = commonBumperAudioUrl(label);
  return {
    ...emptyComposeRecordingDraft({ useEmbeddedAudio: true }),
    title: label,
    script: "",
    mediaUrl: videoUrl,
    sourceDurationMs: ms,
    trimStartMs: 0,
    trimEndMs: ms,
    videoOffsetMs: 0,
    videoSegments: [
      {
        id: `vid-common-${label.toLowerCase()}`,
        trimStartMs: 0,
        trimEndMs: ms,
        offsetMs: 0,
        rate: 1,
      },
    ],
    useEmbeddedAudio: true,
    voiceReplace: false,
    audioUrl,
    audioDurationMs: ms,
    audioSegments: [
      {
        id: `aud-common-${label.toLowerCase()}`,
        trimStartMs: 0,
        trimEndMs: ms,
        offsetMs: 0,
        rate: 1,
      },
    ],
    ready: true,
  };
}

export function commonIntroOutroScene(
  label: CommonBumperLabel = "Intro",
  sceneId?: string,
): Scene {
  const scene = composeRecordingDraftToScene(
    commonIntroOutroRecordingDraft(label),
    sceneId,
  );
  if (!scene) {
    throw new Error("Failed to build common intro/outro scene");
  }
  return {
    ...scene,
    subtitle: label,
  };
}

/**
 * Resolve Intro/Outro label for a timeline scene (subtitle preferred, else media URL).
 * Legacy shared bumper URL is treated as Intro unless subtitle says Outro.
 */
export function commonBumperLabelForScene(
  scene: Pick<Scene, "subtitle" | "mediaUrl">,
): CommonBumperLabel | null {
  if (scene.subtitle === "Intro" || scene.subtitle === "Outro") {
    return scene.subtitle;
  }
  if (scene.mediaUrl === COMMON_OUTRO_VIDEO_URL) return "Outro";
  if (
    scene.mediaUrl === COMMON_INTRO_VIDEO_URL ||
    scene.mediaUrl === COMMON_INTRO_OUTRO_VIDEO_URL
  ) {
    return "Intro";
  }
  return null;
}

/**
 * Normalize stale bumper scenes before export/preview:
 * - rewrite legacy `/common-intro-outro.*` to split intro/outro assets by label
 * - force duration + recording trim/segments to the real bumper length
 *
 * Stale `recordingVideoSegments` (e.g. trimEndMs still 8000 after duration was
 * healed to ~12217) freeze the last ~seconds of the intro in export.
 */
export function healCommonBumperScene(scene: Scene): Scene {
  const label = commonBumperLabelForScene(scene);
  if (!label) return scene;

  const ms = commonBumperDurationMs(label);
  const videoUrl = commonBumperVideoUrl(label);
  const audioUrl = commonBumperAudioUrl(label);
  const vidSeg = scene.recordingVideoSegments?.[0];
  const audSeg = scene.recordingAudioSegments?.[0];
  const segmentsStale =
    (vidSeg != null &&
      (vidSeg.trimEndMs !== ms ||
        vidSeg.trimStartMs !== 0 ||
        (vidSeg.offsetMs ?? 0) !== 0)) ||
    (audSeg != null &&
      (audSeg.trimEndMs !== ms ||
        audSeg.trimStartMs !== 0 ||
        (audSeg.offsetMs ?? 0) !== 0)) ||
    (scene.recordingVideoSegments != null &&
      scene.recordingVideoSegments.length !== 1) ||
    (scene.recordingAudioSegments != null &&
      scene.recordingAudioSegments.length !== 1);

  const needsRewrite =
    scene.mediaUrl !== videoUrl ||
    scene.audioUrl !== audioUrl ||
    scene.durationMs !== ms ||
    scene.recordingTrimEndMs !== ms ||
    scene.recordingSourceDurationMs !== ms ||
    scene.recordingAudioTrimEndMs !== ms ||
    segmentsStale;

  if (!needsRewrite && scene.subtitle === label) return scene;

  const vidId = vidSeg?.id ?? `vid-common-${label.toLowerCase()}`;
  const audId = audSeg?.id ?? `aud-common-${label.toLowerCase()}`;

  return {
    ...scene,
    subtitle: label,
    mediaUrl: videoUrl,
    audioUrl,
    durationMs: ms,
    recordingTrimStartMs: 0,
    recordingTrimEndMs: ms,
    recordingVideoOffsetMs: 0,
    recordingSourceDurationMs: ms,
    recordingVideoSegments: [
      {
        id: vidId,
        trimStartMs: 0,
        trimEndMs: ms,
        offsetMs: 0,
        rate: 1,
      },
    ],
    recordingAudioTrimStartMs: 0,
    recordingAudioTrimEndMs: ms,
    recordingAudioOffsetMs: 0,
    recordingAudioSourceDurationMs: ms,
    recordingAudioSegments: [
      {
        id: audId,
        trimStartMs: 0,
        trimEndMs: ms,
        offsetMs: 0,
        rate: 1,
      },
    ],
    recordingUseEmbeddedAudio: true,
  };
}
