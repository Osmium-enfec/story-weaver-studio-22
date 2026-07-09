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

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
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
 * Slice a full audio file into per-range WAV blob URLs.
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

  const audioUrls: string[] = [];
  const durationsMs: number[] = [];

  for (const r of ranges) {
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
