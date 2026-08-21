import { replicateFetch, requireReplicateKey } from "@/lib/replicate-client";

/**
 * Replicate-backed text-to-image, per text-to-image.md.
 *
 * Talks to api.replicate.com directly (md §7) rather than the Lovable connector
 * gateway (md §5): the gateway needs LOVABLE_API_KEY, which this deployment
 * does not have. Behaviour is otherwise identical — same models, same prompt
 * wrapper, same per-model input shape.
 */

export const IMAGE_MODEL_OPTIONS = ["nano-banana-2", "flux-2-klein-9b"] as const;
export type ImageModelId = (typeof IMAGE_MODEL_OPTIONS)[number];

export const IMAGE_ASPECT_OPTIONS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
export type ImageAspect = (typeof IMAGE_ASPECT_OPTIONS)[number];

export const IMAGE_MODEL_LABELS: Record<ImageModelId, string> = {
  "nano-banana-2": "Nano Banana 2 (Gemini 3.1 Flash Image)",
  "flux-2-klein-9b": "FLUX.2 Klein 9B",
};

const IMAGE_MODEL_PATHS: Record<ImageModelId, string> = {
  "nano-banana-2": "google/nano-banana-2",
  "flux-2-klein-9b": "black-forest-labs/flux-2-klein-9b",
};

// md §3 — exact strings.
const SYSTEM_PREAMBLE =
  "You are an illustration generator. Treat the user's input below as the SOURCE CONTENT to visually illustrate — never render the raw text, code, or script as typography in the image. Instead, create a single clear conceptual illustration that visually represents the ideas, objects, characters, or concepts described in the content.";
const WHITE_BG =
  "The image MUST be rendered on a totally plain, pure white (#FFFFFF) background — no scenery, gradients, textures, background shadows, or environmental elements.";

/** md §3 STYLE_LINE — only meaningful when reference images are attached. */
export function styleLine(refCount: number): string {
  if (refCount < 1) return "";
  return `You MUST strictly match the visual style, line weight, color palette, shapes and overall aesthetic of the provided reference image${refCount > 1 ? "s" : ""}. The references define the required art style for this image.`;
}

/**
 * md §3 — SYSTEM_PREAMBLE / STYLE_LINE / WHITE_BG / --- SOURCE CONTENT --- / prompt
 *
 * Not used by the compose flow: §3 forbids rendering typography and asks for a
 * single illustration, but compose needs labelled cards it can crop and animate
 * individually, so it sends COURSE_VISUAL_STYLE instead. Kept for md-exact use.
 */
export function buildWrappedPrompt(userPrompt: string, refCount = 0): string {
  return [SYSTEM_PREAMBLE, styleLine(refCount), WHITE_BG, "--- SOURCE CONTENT ---", userPrompt]
    .filter(Boolean)
    .join("\n\n");
}

/** md §4 — nano-banana-2 uses `image_input`; flux uses `images` (max 5). */
function buildImageInput(
  model: ImageModelId,
  opts: { prompt: string; aspect: ImageAspect; referenceUrls: string[] },
): Record<string, unknown> {
  const { prompt, aspect, referenceUrls } = opts;
  const input: Record<string, unknown> = { prompt, aspect_ratio: aspect };
  if (referenceUrls.length) {
    if (model === "nano-banana-2") input.image_input = referenceUrls;
    else input.images = referenceUrls.slice(0, 5);
  }
  return input;
}

type Prediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[] | null;
  error?: string | null;
};

function outputUrl(output: Prediction["output"]): string | undefined {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output[0];
  return undefined;
}

/** md §5.2 — create prediction. 402 means no Replicate credit; do not retry. */
async function createPrediction(
  model: ImageModelId,
  input: Record<string, unknown>,
): Promise<string> {
  const res = await replicateFetch(`/models/${IMAGE_MODEL_PATHS[model]}/predictions`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  if (res.status === 402) {
    throw new Error(
      "Replicate account has no credit. Enable billing at https://replicate.com/account/billing.",
    );
  }
  if (!res.ok) {
    throw new Error(`Failed to start image generation (${res.status}): ${(await res.text()).slice(0, 240)}`);
  }
  return ((await res.json()) as Prediction).id;
}

/** md §5.3 — poll every 3s until terminal. */
async function pollPrediction(id: string, timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await replicateFetch(`/predictions/${id}`, { method: "GET" });
    if (!res.ok) throw new Error(`Poll failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as Prediction;

    if (json.status === "succeeded") {
      const url = outputUrl(json.output);
      if (!url) throw new Error("Image generation succeeded but returned no output URL.");
      return url;
    }
    if (json.status === "failed" || json.status === "canceled") {
      throw new Error(`Image generation ${json.status}: ${json.error ?? "unknown error"}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Image generation timed out.");
}

/** md §5.4 — re-download server-side so the caller gets a stable data URL. */
async function toDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download generated image (${res.status}).`);
  const contentType = res.headers.get("content-type") ?? "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buf.toString("base64")}`;
}

/**
 * md §5.1 — upload one PNG to Replicate /v1/files, returning the public URL
 * that models read via image_input / images.
 *
 * Replicate expires these files 24h after upload, so the expiry is returned
 * for callers that cache the URL.
 */
export async function uploadReferenceImage(
  input: string | Buffer,
  contentType = "image/png",
): Promise<{ url: string; expiresAt: number }> {
  let bytes: Buffer;
  let mime = contentType;
  if (typeof input === "string") {
    const m = input.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error("Style reference must be a base64 data URL");
    mime = m[1];
    bytes = Buffer.from(m[2], "base64");
  } else {
    bytes = input;
  }

  const form = new FormData();
  // Copy into a plain Uint8Array — Buffer's ArrayBufferLike is not a BlobPart.
  form.append("content", new Blob([new Uint8Array(bytes)], { type: mime }), "style.png");
  const res = await replicateFetch("/files", { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`Reference upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { urls?: { get?: string }; expires_at?: string };
  const url = json.urls?.get;
  if (!url) throw new Error("Reference upload returned no URL");

  const expiresAt = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 24 * 3600_000;
  return { url, expiresAt };
}

/**
 * build input (§4) → create (§5.2) → poll (§5.3) → re-download (§5.4).
 *
 * `prompt` is sent as the FINAL prompt — callers decide their own wrapping.
 * Compose sends COURSE_VISUAL_STYLE; use buildWrappedPrompt() for md §3.
 */
export async function generateReplicateImageDataUrl(opts: {
  model: ImageModelId;
  prompt: string;
  aspect?: ImageAspect;
  referenceUrls?: string[];
}): Promise<string> {
  requireReplicateKey();
  const input = buildImageInput(opts.model, {
    prompt: opts.prompt,
    aspect: opts.aspect ?? "1:1",
    referenceUrls: opts.referenceUrls ?? [],
  });
  const id = await createPrediction(opts.model, input);
  return toDataUrl(await pollPrediction(id));
}
