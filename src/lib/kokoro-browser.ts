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

/** Synthesizes narration on-device and returns it as a `data:audio/wav` URL. */
export async function synthesizeKokoroDataUrl(
  text: string,
  voice: string = KOKORO_DEFAULT_VOICE,
): Promise<string> {
  const tts = await loadKokoro();
  const audio = await tts.generate(text, { voice });
  const blob = audio.toBlob
    ? audio.toBlob()
    : new Blob([audio.toWav!()], { type: "audio/wav" });
  return blobToDataUrl(blob);
}
