import { encodeWav } from "./audio-slice";
import type { RecordingAudioSegment } from "./compose-scene";
import {
  clampPlaybackRate,
  normalizeRecordingAudioSegments,
  recordingSegmentDurationMs,
} from "./compose-scene";
import { getAudioContextCtor } from "./web-global";

async function decodeUrl(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const ab = await fetch(url).then((r) => r.arrayBuffer());
  return ctx.decodeAudioData(ab.slice(0));
}

/**
 * Build a scene-length narration track from one or more trimmed TTS slices.
 * Honors per-segment playback rate (stretch/compress into the timeline window).
 */
export async function layoutRecordingSceneAudio(
  url: string,
  opts: {
    segments?: RecordingAudioSegment[];
    /** Legacy single-clip fallback */
    trimStartMs?: number;
    trimEndMs?: number;
    offsetMs?: number;
    sceneDurationMs: number;
    audioDurationMs?: number;
  },
): Promise<{ url: string; durationMs: number }> {
  const AC = getAudioContextCtor();
  if (!AC) throw new Error("Web Audio not available");
  const ctx: AudioContext = new AC();

  try {
    const src = await decodeUrl(ctx, url);
    const sr = src.sampleRate;
    const numCh = src.numberOfChannels;
    const sourceMs = src.duration * 1000;

    const segments = normalizeRecordingAudioSegments({
      audioSegments: opts.segments,
      audioDurationMs: opts.audioDurationMs ?? sourceMs,
      audioTrimStartMs: opts.trimStartMs,
      audioTrimEndMs: opts.trimEndMs,
      audioOffsetMs: opts.offsetMs,
    });

    let maxEnd = Math.round((opts.sceneDurationMs / 1000) * sr);
    for (const seg of segments) {
      const endSample =
        Math.round((seg.offsetMs / 1000) * sr) +
        Math.max(1, Math.round((recordingSegmentDurationMs(seg) / 1000) * sr));
      maxEnd = Math.max(maxEnd, endSample);
    }

    const out = ctx.createBuffer(numCh, Math.max(1, maxEnd), sr);
    for (const seg of segments) {
      const trimStart = Math.max(0, Math.min(seg.trimStartMs, sourceMs));
      const trimEnd = Math.max(
        trimStart + 1,
        Math.min(seg.trimEndMs > 0 ? seg.trimEndMs : sourceMs, sourceMs),
      );
      const trimStartSample = Math.floor((trimStart / 1000) * sr);
      const trimEndSample = Math.min(src.length, Math.ceil((trimEnd / 1000) * sr));
      const srcLen = Math.max(1, trimEndSample - trimStartSample);
      const rate = clampPlaybackRate(seg.rate);
      const outLen = Math.max(1, Math.round(srcLen / rate));
      const offsetSamples = Math.max(0, Math.round((seg.offsetMs / 1000) * sr));
      for (let c = 0; c < numCh; c++) {
        const dst = out.getChannelData(c);
        const ch = src.getChannelData(Math.min(c, src.numberOfChannels - 1));
        const copyLen = Math.min(outLen, out.length - offsetSamples);
        for (let i = 0; i < copyLen; i++) {
          const srcPos = i * rate;
          const i0 = Math.floor(srcPos);
          const i1 = Math.min(srcLen - 1, i0 + 1);
          const frac = srcPos - i0;
          const s0 = ch[trimStartSample + i0] ?? 0;
          const s1 = ch[trimStartSample + i1] ?? s0;
          dst[offsetSamples + i] = s0 + (s1 - s0) * frac;
        }
      }
    }

    const wav = encodeWav(out);
    return {
      url: URL.createObjectURL(new Blob([wav], { type: "audio/wav" })),
      durationMs: Math.round((out.length / sr) * 1000),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Map scene clock (ms) to source audio time (sec), or null when silent. */
export function recordingAudioSourceTimeSec(
  scene: {
    recordingAudioSegments?: RecordingAudioSegment[];
    recordingAudioTrimStartMs?: number;
    recordingAudioTrimEndMs?: number;
    recordingAudioSourceDurationMs?: number;
    recordingAudioOffsetMs?: number;
    durationMs?: number;
  },
  clockMs: number,
): number | null {
  const segments = normalizeRecordingAudioSegments({
    audioSegments: scene.recordingAudioSegments,
    audioDurationMs: scene.recordingAudioSourceDurationMs ?? scene.durationMs ?? 0,
    audioTrimStartMs: scene.recordingAudioTrimStartMs,
    audioTrimEndMs: scene.recordingAudioTrimEndMs,
    audioOffsetMs: scene.recordingAudioOffsetMs,
  });
  for (const seg of segments) {
    const trimmed = recordingSegmentDurationMs(seg);
    const local = clockMs - seg.offsetMs;
    if (local >= 0 && local <= trimmed) {
      const rate = clampPlaybackRate(seg.rate);
      return (seg.trimStartMs + local * rate) / 1000;
    }
  }
  return null;
}

/**
 * Inverse of recordingAudioSourceTimeSec — map playing audio source time → scene clock.
 * Used so preview can let <audio> play natively (smooth voice) instead of seeking every frame.
 */
export function recordingClockMsFromAudioSourceSec(
  scene: {
    recordingAudioSegments?: RecordingAudioSegment[];
    recordingAudioTrimStartMs?: number;
    recordingAudioTrimEndMs?: number;
    recordingAudioSourceDurationMs?: number;
    recordingAudioOffsetMs?: number;
    durationMs?: number;
  },
  sourceSec: number,
): number | null {
  const sourceMs = sourceSec * 1000;
  const segments = normalizeRecordingAudioSegments({
    audioSegments: scene.recordingAudioSegments,
    audioDurationMs: scene.recordingAudioSourceDurationMs ?? scene.durationMs ?? 0,
    audioTrimStartMs: scene.recordingAudioTrimStartMs,
    audioTrimEndMs: scene.recordingAudioTrimEndMs,
    audioOffsetMs: scene.recordingAudioOffsetMs,
  });
  for (const seg of segments) {
    const rate = clampPlaybackRate(seg.rate);
    const trimStart = seg.trimStartMs;
    const trimEnd = seg.trimEndMs > seg.trimStartMs ? seg.trimEndMs : trimStart;
    if (sourceMs + 1 < trimStart || sourceMs > trimEnd + 1) continue;
    const localSource = Math.max(0, Math.min(trimEnd, sourceMs) - trimStart);
    const localTimeline = localSource / rate;
    return seg.offsetMs + localTimeline;
  }
  return null;
}

/** Active audio segment rate at clock (1 when silent). */
export function recordingAudioRateAtClock(
  scene: {
    recordingAudioSegments?: RecordingAudioSegment[];
    recordingAudioTrimStartMs?: number;
    recordingAudioTrimEndMs?: number;
    recordingAudioSourceDurationMs?: number;
    recordingAudioOffsetMs?: number;
    durationMs?: number;
  },
  clockMs: number,
): number {
  const segments = normalizeRecordingAudioSegments({
    audioSegments: scene.recordingAudioSegments,
    audioDurationMs: scene.recordingAudioSourceDurationMs ?? scene.durationMs ?? 0,
    audioTrimStartMs: scene.recordingAudioTrimStartMs,
    audioTrimEndMs: scene.recordingAudioTrimEndMs,
    audioOffsetMs: scene.recordingAudioOffsetMs,
  });
  for (const seg of segments) {
    const trimmed = recordingSegmentDurationMs(seg);
    const local = clockMs - seg.offsetMs;
    if (local >= 0 && local <= trimmed) {
      return clampPlaybackRate(seg.rate);
    }
  }
  return 1;
}
