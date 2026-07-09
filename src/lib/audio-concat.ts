// Concatenate per-sentence TTS clips into ONE continuous audio track and
// return per-clip start/end offsets in ms. The rendered video plays this
// single track and switches visuals on the offsets — no per-scene audio
// reloads, no gaps mid-sentence.

import { encodeWav } from "./audio-slice";

export interface ConcatResult {
  url: string;
  ranges: { startMs: number; endMs: number }[];
  durationMs: number;
}

export async function concatAudioClips(
  urls: string[],
  gapMs = 300,
): Promise<ConcatResult> {
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new AC();
  const buffers: AudioBuffer[] = [];
  for (const u of urls) {
    const ab = await fetch(u).then((r) => r.arrayBuffer());
    // decodeAudioData mutates the ArrayBuffer, so clone.
    buffers.push(await ctx.decodeAudioData(ab.slice(0)));
  }
  const sr = buffers[0]?.sampleRate ?? 44100;
  const numCh = Math.max(1, ...buffers.map((b) => b.numberOfChannels));
  const gapSamples = Math.round((gapMs / 1000) * sr);
  const totalSamples =
    buffers.reduce((s, b) => s + b.length, 0) +
    gapSamples * Math.max(0, buffers.length - 1);

  const out = ctx.createBuffer(numCh, totalSamples, sr);
  const ranges: { startMs: number; endMs: number }[] = [];
  let offset = 0;
  for (let i = 0; i < buffers.length; i++) {
    const b = buffers[i];
    for (let c = 0; c < numCh; c++) {
      const srcCh = Math.min(c, b.numberOfChannels - 1);
      const dst = out.getChannelData(c);
      dst.set(b.getChannelData(srcCh), offset);
    }
    const startMs = (offset / sr) * 1000;
    // Include the trailing gap as part of THIS scene so the next scene
    // starts exactly when the next voice clip begins.
    const clipEnd = offset + b.length;
    const nextStart = i < buffers.length - 1 ? clipEnd + gapSamples : clipEnd;
    const endMs = (nextStart / sr) * 1000;
    ranges.push({ startMs, endMs });
    offset = nextStart;
  }

  const wav = encodeWav(out);
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  await ctx.close().catch(() => {});
  return { url, ranges, durationMs: (totalSamples / sr) * 1000 };
}
