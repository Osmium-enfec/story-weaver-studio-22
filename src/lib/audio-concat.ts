// Concatenate per-scene TTS clips into ONE continuous master track.
// Between scenes: hold silence + whoosh SFX (slide duration matched to SFX length).

import { encodeWav } from "./audio-slice";
import {
  SCENE_HOLD_MS,
  SCENE_TRANSITION_MS,
  TRANSITION_SFX_URL,
} from "./scene-transition";
import { getAudioContextCtor } from "./web-global";

export interface ConcatResult {
  url: string;
  ranges: { startMs: number; endMs: number }[];
  durationMs: number;
  holdMs: number;
  /** Representative / max transition (compat). */
  transitionMs: number;
  /** Per-gap slide durations (length = urls.length - 1). */
  gapTransitionMs: number[];
}

export interface ConcatOptions {
  /** Hold silence before each transition; one value or per-gap array. */
  holdMs?: number | number[];
  /** Visual slide duration (ms); one value or per-gap array. */
  transitionMs?: number | number[];
  /** Whoosh / swoosh played during the slide; defaults to bundled swoosh. */
  transitionSfxUrl?: string;
  /** 0..1 gain for transition SFX; one value or per-gap array (default 0.9). */
  transitionSfxVolume?: number | number[];
}

async function decodeUrl(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    if (url.startsWith("blob:")) {
      throw new Error(
        "Scene audio is missing (temporary link expired). Open that scene, re-save it to the part, then stitch again.",
        { cause },
      );
    }
    throw new Error(
      "Could not load scene audio for stitch. Re-save the affected scene to the part, then try again.",
      { cause },
    );
  }
  if (!res.ok) {
    throw new Error(`Could not load scene audio (${res.status}). Re-save that scene to the part.`);
  }
  const ab = await res.arrayBuffer();
  return ctx.decodeAudioData(ab.slice(0));
}

/**
 * Remove long trailing silence from a decoded clip (keeps a short natural decay tail).
 * Returns the original buffer when there's nothing meaningful to trim.
 */
export function trimTrailingSilenceBuffer(
  buf: AudioBuffer,
  opts?: {
    /** Peak amplitude 0..1 treated as silence (default 0.02). */
    threshold?: number;
    /** Only trim when trailing silence exceeds this (default 250ms). */
    minSilenceMs?: number;
    /** Keep this much after the last loud sample (default 120ms). */
    keepTailMs?: number;
  },
): { buffer: AudioBuffer; trimmedMs: number } {
  const threshold = opts?.threshold ?? 0.02;
  const minSilenceMs = opts?.minSilenceMs ?? 250;
  const keepTailMs = opts?.keepTailMs ?? 120;
  const sr = buf.sampleRate;
  const floatThresh = threshold;

  let lastLoud = -1;
  const ch0 = buf.getChannelData(0);
  for (let i = ch0.length - 1; i >= 0; i--) {
    let peak = Math.abs(ch0[i]!);
    for (let c = 1; c < buf.numberOfChannels; c++) {
      peak = Math.max(peak, Math.abs(buf.getChannelData(c)[i]!));
    }
    if (peak >= floatThresh) {
      lastLoud = i;
      break;
    }
  }
  if (lastLoud < 0) {
    return { buffer: buf, trimmedMs: 0 };
  }

  const keepSamples = Math.round((keepTailMs / 1000) * sr);
  const endSample = Math.min(buf.length, lastLoud + 1 + keepSamples);
  const trailingMs = ((buf.length - endSample) / sr) * 1000;
  if (trailingMs < minSilenceMs || endSample >= buf.length) {
    return { buffer: buf, trimmedMs: 0 };
  }

  const out = new AudioBuffer({
    numberOfChannels: buf.numberOfChannels,
    length: endSample,
    sampleRate: sr,
  });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.getChannelData(c).set(buf.getChannelData(c).subarray(0, endSample));
  }
  return { buffer: out, trimmedMs: Math.round(trailingMs) };
}

/** Trim trailing silence from a media URL; returns a new WAV blob URL when trimmed. */
export async function trimTrailingSilenceFromUrl(
  url: string,
  opts?: Parameters<typeof trimTrailingSilenceBuffer>[1],
): Promise<{ url: string; durationMs: number; trimmedMs: number }> {
  const AC = getAudioContextCtor();
  if (!AC) throw new Error("Web Audio not available");
  const ctx: AudioContext = new AC();
  try {
    const src = await decodeUrl(ctx, url);
    const { buffer, trimmedMs } = trimTrailingSilenceBuffer(src, opts);
    const durationMs = Math.round((buffer.length / buffer.sampleRate) * 1000);
    if (trimmedMs <= 0) {
      return { url, durationMs, trimmedMs: 0 };
    }
    const wav = encodeWav(buffer);
    return {
      url: URL.createObjectURL(new Blob([wav], { type: "audio/wav" })),
      durationMs,
      trimmedMs,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

function expandGapValues(
  value: number | number[] | undefined,
  gapCount: number,
  fallback: number,
): number[] {
  if (gapCount <= 0) return [];
  if (Array.isArray(value)) {
    if (value.length >= gapCount) return value.slice(0, gapCount);
    return [
      ...value,
      ...Array.from({ length: gapCount - value.length }, () => fallback),
    ];
  }
  const scalar = value ?? fallback;
  return Array.from({ length: gapCount }, () => scalar);
}

function appendGap(
  sr: number,
  numCh: number,
  holdMs: number,
  transitionMs: number,
  sfx: AudioBuffer | null,
  sfxVolume: number,
): AudioBuffer {
  const holdSamples = Math.round((holdMs / 1000) * sr);
  const transSamples = Math.round((transitionMs / 1000) * sr);
  const total = Math.max(0, holdSamples + transSamples);
  const gap = new AudioBuffer({ numberOfChannels: numCh, length: total, sampleRate: sr });

  if (sfx && sfx.length > 0 && sfxVolume > 0 && transSamples > 0) {
    const sfxGain = Math.max(0, Math.min(1, sfxVolume));
    const sfxStart = holdSamples;
    const copyLen = Math.min(sfx.length, transSamples);
    for (let c = 0; c < numCh; c++) {
      const dstCh = gap.getChannelData(c);
      const srcCh = sfx.getChannelData(Math.min(c, sfx.numberOfChannels - 1));
      for (let i = 0; i < copyLen; i++) {
        dstCh[sfxStart + i]! += srcCh[i]! * sfxGain;
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
  const gapHolds = expandGapValues(options.holdMs, gapCount, defaultHold);
  const holdMs = gapHolds.length > 0 ? Math.max(...gapHolds) : defaultHold;
  const AC = getAudioContextCtor();
  if (!AC) throw new Error("Web Audio not available");
  const ctx: AudioContext = new AC();

  const sfxUrl =
    urls.length > 1
      ? (options.transitionSfxUrl ?? TRANSITION_SFX_URL)
      : undefined;

  let sfx: AudioBuffer | null = null;
  let sfxDerivedMs: number | null = null;
  if (sfxUrl) {
    try {
      sfx = await decodeUrl(ctx, sfxUrl);
      sfxDerivedMs = Math.max(80, Math.round(sfx.duration * 1000));
    } catch {
      sfx = null;
    }
  }

  const defaultTransition =
    (Array.isArray(options.transitionMs) ? undefined : options.transitionMs) ??
    sfxDerivedMs ??
    SCENE_TRANSITION_MS;
  const gapTransitions = expandGapValues(
    options.transitionMs,
    gapCount,
    defaultTransition,
  );
  const transitionMs =
    gapTransitions.length > 0 ? Math.max(...gapTransitions) : defaultTransition;

  const defaultVolume =
    (Array.isArray(options.transitionSfxVolume)
      ? undefined
      : options.transitionSfxVolume) ?? 0.9;
  const gapVolumes = expandGapValues(
    options.transitionSfxVolume,
    gapCount,
    defaultVolume,
  ).map((v) => Math.max(0, Math.min(1, v)));

  const buffers: AudioBuffer[] = [];
  for (const u of urls) {
    buffers.push(await decodeUrl(ctx, u));
  }

  const sr = buffers[0]?.sampleRate ?? 44100;
  const numCh = Math.max(1, ...buffers.map((b) => b.numberOfChannels));
  const gapBuffers =
    gapCount > 0
      ? gapHolds.map((gapHold, i) =>
          appendGap(
            sr,
            numCh,
            gapHold,
            gapTransitions[i] ?? defaultTransition,
            sfx,
            gapVolumes[i] ?? defaultVolume,
          ),
        )
      : [];

  const totalSamples =
    buffers.reduce((s, b) => s + b.length, 0) +
    gapBuffers.reduce((s, g) => s + g.length, 0);

  const out = ctx.createBuffer(numCh, totalSamples, sr);
  const ranges: { startMs: number; endMs: number }[] = [];
  let offset = 0;

  for (let i = 0; i < buffers.length; i++) {
    const b = buffers[i]!;
    for (let c = 0; c < numCh; c++) {
      const srcCh = Math.min(c, b.numberOfChannels - 1);
      out.getChannelData(c).set(b.getChannelData(srcCh), offset);
    }
    const startMs = (offset / sr) * 1000;
    const clipEnd = offset + b.length;
    const hasGap = i < buffers.length - 1;
    let nextOffset = clipEnd;
    if (hasGap) {
      const gap = gapBuffers[i]!;
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
  return {
    url,
    ranges,
    durationMs: (totalSamples / sr) * 1000,
    holdMs,
    transitionMs,
    gapTransitionMs: gapTransitions,
  };
}

/** Join two clips with silent gap between them (for question intro + narration). */
export async function concatTwoWithGap(
  urlA: string,
  urlB: string,
  gapMs: number,
): Promise<{ url: string; durationMs: number; partBDurationMs: number }> {
  const AC = getAudioContextCtor();
  if (!AC) throw new Error("Web Audio not available");
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

/** Append trailing silence (e.g. last-question countdown hold with no slide). */
export async function appendSilenceToAudio(
  url: string,
  silenceMs: number,
): Promise<{ url: string; durationMs: number }> {
  if (silenceMs <= 0) {
    const AC = getAudioContextCtor();
    if (!AC) throw new Error("Web Audio not available");
    const ctx: AudioContext = new AC();
    try {
      const buf = await decodeUrl(ctx, url);
      return { url, durationMs: Math.round((buf.length / buf.sampleRate) * 1000) };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  const AC = getAudioContextCtor();
  if (!AC) throw new Error("Web Audio not available");
  const ctx: AudioContext = new AC();
  try {
    const src = await decodeUrl(ctx, url);
    const sr = src.sampleRate;
    const numCh = src.numberOfChannels;
    const silenceSamples = Math.round((silenceMs / 1000) * sr);
    const totalSamples = src.length + silenceSamples;
    const out = ctx.createBuffer(numCh, totalSamples, sr);
    for (let c = 0; c < numCh; c++) {
      out.getChannelData(c).set(src.getChannelData(c), 0);
    }
    const wav = encodeWav(out);
    return {
      url: URL.createObjectURL(new Blob([wav], { type: "audio/wav" })),
      durationMs: Math.round((totalSamples / sr) * 1000),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Create a silent WAV of the given length (for narration-free scenes). */
export async function createSilentAudioUrl(
  durationMs: number,
  sampleRate = 44100,
): Promise<{ url: string; durationMs: number }> {
  const ms = Math.max(100, Math.round(durationMs));
  const AC = getAudioContextCtor();
  if (!AC) throw new Error("Web Audio not available");
  const ctx: AudioContext = new AC();
  try {
    const length = Math.max(1, Math.round((ms / 1000) * sampleRate));
    const buf = ctx.createBuffer(1, length, sampleRate);
    const wav = encodeWav(buf);
    return {
      url: URL.createObjectURL(new Blob([wav], { type: "audio/wav" })),
      durationMs: Math.round((length / sampleRate) * 1000),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}
