/**
 * Kokoro narration in the browser (client-only).
 *
 * Kokoro-82M runs on the viewer's own machine through ONNX Runtime Web, so it
 * works on every deployment (including the Lovable-hosted site) without any
 * Kokoro server. The quantized model (~90MB) is downloaded once and cached by
 * the browser.
 */

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

export const KOKORO_DEFAULT_VOICE = "af_heart";

type KokoroInstance = {
  generate: (
    text: string,
    options: { voice: string },
  ) => Promise<{ toBlob?: () => Blob; toWav?: () => ArrayBuffer }>;
};

let loading: Promise<KokoroInstance> | null = null;

const hasWebGPU = () =>
  typeof navigator !== "undefined" &&
  "gpu" in navigator &&
  Boolean((navigator as unknown as { gpu?: unknown }).gpu);

/** Loads (and caches) the on-device model. WebGPU when available, else WASM. */
export async function loadKokoro(): Promise<KokoroInstance> {
  if (loading) return loading;
  loading = (async () => {
    const { KokoroTTS } = await import("kokoro-js");
    const webgpu = hasWebGPU();
    try {
      return (await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: webgpu ? "fp32" : "q8",
        device: webgpu ? "webgpu" : "wasm",
      })) as unknown as KokoroInstance;
    } catch (error) {
      if (!webgpu) throw error;
      // Some GPUs/drivers reject the shader pipeline — fall back to CPU.
      return (await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8",
        device: "wasm",
      })) as unknown as KokoroInstance;
    }
  })();
  try {
    return await loading;
  } catch (error) {
    loading = null;
    throw error;
  }
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read audio"));
    reader.readAsDataURL(blob);
  });

/**
 * Kokoro-82M silently truncates around ~510 phonemes (~25s of speech), so long
 * narration must be split and the clips joined back together.
 */
const KOKORO_CHUNK_CHARS = 280;

function splitKokoroText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (cleaned.length <= KOKORO_CHUNK_CHARS) return [cleaned];

  const sentences = cleaned
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pieces = sentences.length ? sentences : [cleaned];
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };

  for (const piece of pieces) {
    if (piece.length > KOKORO_CHUNK_CHARS) {
      flush();
      const words = piece.split(/\s+/).filter(Boolean);
      let line = "";
      for (const word of words) {
        if (line && line.length + word.length + 1 > KOKORO_CHUNK_CHARS) {
          out.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) out.push(line);
      continue;
    }
    if (buf && buf.length + piece.length + 1 > KOKORO_CHUNK_CHARS) flush();
    buf = buf ? `${buf} ${piece}` : piece;
  }
  flush();
  return out.length ? out : [cleaned];
}

async function generateBlob(
  tts: KokoroInstance,
  text: string,
  voice: string,
): Promise<Blob> {
  const audio = await tts.generate(text, { voice });
  return audio.toBlob ? audio.toBlob() : new Blob([audio.toWav!()], { type: "audio/wav" });
}

/** Decodes every clip, joins them with a short breath, re-encodes one WAV. */
async function concatWavBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 1) return blobs[0]!;
  const Ctx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = [] as AudioBuffer[];
    for (const blob of blobs) {
      decoded.push(await ctx.decodeAudioData(await blob.arrayBuffer()));
    }
    const rate = decoded[0]!.sampleRate;
    const gapSamples = Math.round(rate * 0.12);
    const total =
      decoded.reduce((n, b) => n + b.length, 0) + gapSamples * (decoded.length - 1);
    const merged = new Float32Array(total);
    let offset = 0;
    decoded.forEach((buf, i) => {
      merged.set(buf.getChannelData(0), offset);
      offset += buf.length + (i < decoded.length - 1 ? gapSamples : 0);
    });
    return encodeWav(merged, rate);
  } finally {
    void ctx.close().catch(() => {});
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (pos: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let pos = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    pos += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Synthesizes narration on-device and returns it as a `data:audio/wav` URL. */
export async function synthesizeKokoroDataUrl(
  text: string,
  voice: string = KOKORO_DEFAULT_VOICE,
): Promise<string> {
  const tts = await loadKokoro();
  const chunks = splitKokoroText(text);
  if (!chunks.length) throw new Error("Narration text is empty.");
  const blobs: Blob[] = [];
  for (const chunk of chunks) {
    blobs.push(await generateBlob(tts, chunk, voice));
  }
  return blobToDataUrl(await concatWavBlobs(blobs));
}
