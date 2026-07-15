// Concatenate per-scene TTS clips into ONE continuous master track.
// Between scenes: hold silence + whoosh SFX (slide duration matched to SFX length).

import { encodeWav } from "./audio-slice";
import {
  SCENE_HOLD_MS,
  SCENE_TRANSITION_MS,
  TRANSITION_SFX_URL,
} from "./scene-transition";

export interface ConcatResult {
  url: string;
  ranges: { startMs: number; endMs: number }[];
  durationMs: number;
  holdMs: number;
  transitionMs: number;
}

export interface ConcatOptions {
  /** Hold silence before each transition; one value or per-gap array. */
  holdMs?: number | number[];
  /** When omitted, derived from the SFX clip duration. */
  transitionMs?: number;
  /** Whoosh played during the slide; defaults to bundled transition-whoosh.mp3 */
  transitionSfxUrl?: string;
}

async function decodeUrl(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const ab = await fetch(url).then((r) => r.arrayBuffer());
  return ctx.decodeAudioData(ab.slice(0));
}

function appendGap(
  sr: number,
  numCh: number,
  holdMs: number,
  transitionMs: number,
  sfx: AudioBuffer | null,
): AudioBuffer {
  const holdSamples = Math.round((holdMs / 1000) * sr);
  const transSamples = Math.round((transitionMs / 1000) * sr);
  const total = holdSamples + transSamples;
  const gap = new AudioBuffer({ numberOfChannels: numCh, length: total, sampleRate: sr });

  if (sfx && sfx.length > 0) {
    const sfxGain = 0.9;
    const sfxStart = holdSamples;
    const copyLen = Math.min(sfx.length, transSamples);
    for (let c = 0; c < numCh; c++) {
      const dstCh = gap.getChannelData(c);
      const srcCh = sfx.getChannelData(Math.min(c, sfx.numberOfChannels - 1));
      for (let i = 0; i < copyLen; i++) {
        dstCh[sfxStart + i] += srcCh[i] * sfxGain;
      }
    }
  }
  return gap;
}

/**
 * Stitch scene narration clips: hold silence, then whoosh SFX whose length
 * sets the visual slide duration so audio and animation stay in sync.
 */
export async function concatAudioClips(
  urls: string[],
  options: ConcatOptions = {},
): Promise<ConcatResult> {
  const defaultHold = SCENE_HOLD_MS;
  const gapCount = Math.max(0, urls.length - 1);
  const gapHolds: number[] =
    gapCount === 0
      ? []
      : Array.isArray(options.holdMs)
        ? options.holdMs.length >= gapCount
          ? options.holdMs.slice(0, gapCount)
          : [
              ...options.holdMs,
              ...Array.from(
                { length: gapCount - options.holdMs.length },
                () => defaultHold,
              ),
            ]
        : Array.from({ length: gapCount }, () => options.holdMs ?? defaultHold);
  const holdMs = gapHolds.length > 0 ? Math.max(...gapHolds) : defaultHold;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new AC();

  const sfxUrl =
    urls.length > 1
      ? (options.transitionSfxUrl ?? TRANSITION_SFX_URL)
      : undefined;

  let sfx: AudioBuffer | null = null;
  let transitionMs = options.transitionMs;
  if (sfxUrl) {
    try {
      sfx = await decodeUrl(ctx, sfxUrl);
      if (transitionMs == null) {
        transitionMs = Math.max(80, Math.round(sfx.duration * 1000));
      }
    } catch {
      sfx = null;
    }
  }
  if (transitionMs == null) transitionMs = SCENE_TRANSITION_MS;

  const buffers: AudioBuffer[] = [];
  for (const u of urls) {
    buffers.push(await decodeUrl(ctx, u));
  }

  const sr = buffers[0]?.sampleRate ?? 44100;
  const numCh = Math.max(1, ...buffers.map((b) => b.numberOfChannels));
  const gapBuffers =
    gapCount > 0
      ? gapHolds.map((gapHold) =>
          appendGap(sr, numCh, gapHold, transitionMs, sfx),
        )
      : [];

  const totalSamples =
    buffers.reduce((s, b) => s + b.length, 0) +
    gapBuffers.reduce((s, g) => s + g.length, 0);

  const out = ctx.createBuffer(numCh, totalSamples, sr);
  const ranges: { startMs: number; endMs: number }[] = [];
  let offset = 0;

  for (let i = 0; i < buffers.length; i++) {
    const b = buffers[i];
    for (let c = 0; c < numCh; c++) {
      const srcCh = Math.min(c, b.numberOfChannels - 1);
      out.getChannelData(c).set(b.getChannelData(srcCh), offset);
    }
    const startMs = (offset / sr) * 1000;
    const clipEnd = offset + b.length;
    const hasGap = i < buffers.length - 1;
    let nextOffset = clipEnd;
    if (hasGap) {
      const gap = gapBuffers[i];
      for (let c = 0; c < numCh; c++) {
        out.getChannelData(c).set(gap.getChannelData(c), clipEnd);
      }
      nextOffset = clipEnd + gap.length;
    }
    ranges.push({ startMs, endMs: (nextOffset / sr) * 1000 });
    offset = nextOffset;
  }

  const wav = encodeWav(out);
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  await ctx.close().catch(() => {});
  return { url, ranges, durationMs: (totalSamples / sr) * 1000, holdMs, transitionMs };
}

/** Join two clips with silent gap between them (for question intro + narration). */
export async function concatTwoWithGap(
  urlA: string,
  urlB: string,
  gapMs: number,
): Promise<{ url: string; durationMs: number; partBDurationMs: number }> {
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new AC();
  const [a, b] = await Promise.all([decodeUrl(ctx, urlA), decodeUrl(ctx, urlB)]);
  const sr = a.sampleRate;
  const numCh = Math.max(a.numberOfChannels, b.numberOfChannels);
  const gapSamples = Math.round((gapMs / 1000) * sr);
  const totalSamples = a.length + gapSamples + b.length;
  const out = ctx.createBuffer(numCh, totalSamples, sr);

  let offset = 0;
  for (let c = 0; c < numCh; c++) {
    const dst = out.getChannelData(c);
    const srcA = a.getChannelData(Math.min(c, a.numberOfChannels - 1));
    dst.set(srcA, offset);
  }
  offset += a.length + gapSamples;
  for (let c = 0; c < numCh; c++) {
    const dst = out.getChannelData(c);
    const srcB = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
    dst.set(srcB, offset);
  }

  const wav = encodeWav(out);
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  await ctx.close().catch(() => {});
  return {
    url,
    durationMs: (totalSamples / sr) * 1000,
    partBDurationMs: Math.round((b.length / sr) * 1000),
  };
}
