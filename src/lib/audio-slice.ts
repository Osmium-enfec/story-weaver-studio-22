// Client-side audio decoding, sentence alignment, and per-scene WAV slicing.

export interface SttWord {
  text: string;
  start: number;
  end: number;
  type?: string;
}

export interface SttResult {
  text: string;
  words: SttWord[];
}

function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SentenceRange {
  start: number;
  end: number;
}

/**
 * Walk sentences and consume STT words in order. Returns [start,end] seconds
 * for each sentence. Robust to punctuation, casing, and small mismatches.
 */
export function alignSentences(sentences: string[], words: SttWord[]): SentenceRange[] {
  const w = words.filter((x) => (x.type ?? "word") === "word" && x.text.trim().length > 0);
  let idx = 0;
  return sentences.map((sent) => {
    const tokens = normalize(sent).split(" ").filter(Boolean);
    if (!tokens.length || idx >= w.length) {
      const last = w[w.length - 1]?.end ?? 0;
      return { start: last, end: last };
    }
    const start = w[idx].start;
    let matched = 0;
    let lastConsumed = idx;
    while (idx < w.length && matched < tokens.length) {
      const wt = normalize(w[idx].text);
      if (wt && wt === tokens[matched]) {
        matched++;
        lastConsumed = idx;
        idx++;
      } else {
        // consume word even if it doesn't match (tolerates minor drift)
        lastConsumed = idx;
        idx++;
        // if we've drifted way past, break to avoid burning through whole audio
        if (matched === 0 && idx - lastConsumed > 6) break;
      }
    }
    const end = w[lastConsumed]?.end ?? start;
    return { start, end };
  });
}

export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * numCh * 2 + 44;
  const ab = new ArrayBuffer(length);
  const view = new DataView(ab);

  function writeStr(offset: number, s: string) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  }

  writeStr(0, "RIFF");
  view.setUint32(4, length - 8, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, length - 44, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, s, true);
      offset += 2;
    }
  }
  return ab;
}

/**
 * Snap sentence-aligned ranges to the nearest silence in the waveform so
 * scenes cut where the speaker actually pauses, not mid-word.
 * `silenceThresh` is amplitude (0..1); `minSilenceMs` is min continuous
 * silence to count. Adjusts each range's `end` (and next range's `start`)
 * to the middle of the nearest silence window found within +/- maxDriftMs.
 */
export function snapRangesToSilence(
  buffer: AudioBuffer,
  ranges: SentenceRange[],
  opts: { silenceThresh?: number; minSilenceMs?: number; maxDriftMs?: number } = {},
): SentenceRange[] {
  const silenceThresh = opts.silenceThresh ?? 0.02;
  const minSilenceMs = opts.minSilenceMs ?? 180;
  const maxDriftMs = opts.maxDriftMs ?? 600;
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);

  // RMS window of 20ms
  const win = Math.max(1, Math.floor(sr * 0.02));
  const rms: number[] = [];
  for (let i = 0; i < ch.length; i += win) {
    let sum = 0;
    const end = Math.min(ch.length, i + win);
    for (let j = i; j < end; j++) sum += ch[j] * ch[j];
    rms.push(Math.sqrt(sum / (end - i)));
  }
  const winMs = (win / sr) * 1000;
  const minSilenceWins = Math.max(1, Math.round(minSilenceMs / winMs));

  // Find silence midpoints (in seconds) — center of any run of quiet windows.
  const silences: number[] = [];
  let runStart = -1;
  for (let i = 0; i < rms.length; i++) {
    const quiet = rms[i] < silenceThresh;
    if (quiet && runStart < 0) runStart = i;
    else if (!quiet && runStart >= 0) {
      if (i - runStart >= minSilenceWins) {
        silences.push(((runStart + i) / 2) * (winMs / 1000));
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && rms.length - runStart >= minSilenceWins) {
    silences.push(((runStart + rms.length) / 2) * (winMs / 1000));
  }

  const nearestSilence = (t: number) => {
    let best = t;
    let bestD = Infinity;
    for (const s of silences) {
      const d = Math.abs(s - t);
      if (d < bestD && d * 1000 <= maxDriftMs) {
        best = s;
        bestD = d;
      }
    }
    return best;
  };

  const snapped = ranges.map((r) => ({ ...r }));
  for (let i = 0; i < snapped.length - 1; i++) {
    const boundary = (snapped[i].end + snapped[i + 1].start) / 2;
    const snap = nearestSilence(boundary);
    snapped[i].end = snap;
    snapped[i + 1].start = snap;
  }
  return snapped;
}

/**
 * Decode `file`, snap sentence ranges to nearby silence, and return
 * per-scene boundaries in milliseconds. Does NOT slice — the app keeps
 * the ORIGINAL audio playing continuously and switches visuals at
 * these timestamps.
 */
export async function computeSnappedRangesMs(
  file: File,
  ranges: SentenceRange[],
): Promise<{ startMs: number; endMs: number }[]> {
  const ab = await file.arrayBuffer();
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new AC();
  const buf = await ctx.decodeAudioData(ab.slice(0));
  const snapped = snapRangesToSilence(buf, ranges);
  await ctx.close().catch(() => {});
  // Ensure scenes are contiguous: each scene's start == previous end.
  const out: { startMs: number; endMs: number }[] = [];
  for (let i = 0; i < snapped.length; i++) {
    const start = i === 0 ? 0 : out[i - 1].endMs;
    const end = i === snapped.length - 1
      ? Math.max(start + 200, (buf.length / buf.sampleRate) * 1000)
      : Math.max(start + 200, snapped[i].end * 1000);
    out.push({ startMs: start, endMs: end });
  }
  return out;
}

/**
 * Slice a full audio file into per-range WAV blob URLs.
 * Snaps sentence ranges to silence gaps so cuts feel natural.
 * Returns { audioUrls, durationsMs } same length as ranges.
 */
export async function sliceAudioIntoScenes(
  file: File,
  ranges: SentenceRange[],
): Promise<{ audioUrls: string[]; durationsMs: number[] }> {
  const ArrayBufferData = await file.arrayBuffer();
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new AC();
  const full = await ctx.decodeAudioData(ArrayBufferData.slice(0));

  const snapped = snapRangesToSilence(full, ranges);

  const audioUrls: string[] = [];
  const durationsMs: number[] = [];

  for (const r of snapped) {
    const sr = full.sampleRate;
    const startSample = Math.max(0, Math.floor(r.start * sr));
    const endSample = Math.min(full.length, Math.max(startSample + 1, Math.floor(r.end * sr)));
    const length = endSample - startSample;
    const out = ctx.createBuffer(full.numberOfChannels, length, sr);
    for (let c = 0; c < full.numberOfChannels; c++) {
      const src = full.getChannelData(c);
      out.copyToChannel(src.subarray(startSample, endSample), c);
    }
    const wav = encodeWav(out);
    const blob = new Blob([wav], { type: "audio/wav" });
    audioUrls.push(URL.createObjectURL(blob));
    durationsMs.push((length / sr) * 1000);
  }

  await ctx.close().catch(() => {});
  return { audioUrls, durationsMs };
}
