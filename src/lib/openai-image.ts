import { COMPOSITE_IMAGE_SIZE } from "./course-visual-style";
import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "./openai-env";

export const DEFAULT_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
/** medium ~20–40s; high can exceed 100s and cause worker fetch timeouts. */
export const DEFAULT_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY ?? "medium";
/** gpt-image-1 supported landscape size (1024×1024, 1024×1536, 1536×1024, auto). */
export const DEFAULT_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE ?? COMPOSITE_IMAGE_SIZE;

const IMAGE_TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS ?? 120_000);

export interface ImageGenerationOptions {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  timeoutMs?: number;
}

function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  const causeMsg =
    cause instanceof Error
      ? cause.message
      : cause != null
        ? String(cause)
        : "";
  if (causeMsg && causeMsg !== err.message) {
    return `${err.message} (${causeMsg})`;
  }
  return err.message;
}

/** POST /images/generations with abort timeout and clearer errors. */
export async function generateOpenAIImageB64(
  opts: ImageGenerationOptions,
): Promise<string> {
  requireOpenAIKey();
  const model = opts.model ?? DEFAULT_IMAGE_MODEL;
  const size = opts.size ?? DEFAULT_IMAGE_SIZE;
  const quality = opts.quality ?? DEFAULT_IMAGE_QUALITY;
  const timeoutMs = opts.timeoutMs ?? IMAGE_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${OPENAI_API}/images/generations`, {
      method: "POST",
      headers: openAIHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt: opts.prompt,
        size,
        n: 1,
        quality,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OpenAI images ${res.status}: ${text.slice(0, 400)}`);
    }
    let j: { data?: Array<{ b64_json?: string }> };
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`OpenAI images parse failed: ${text.slice(0, 300)}`);
    }
    const b64 = j?.data?.[0]?.b64_json;
    if (!b64) throw new Error(`OpenAI images returned no data: ${text.slice(0, 300)}`);
    return b64;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `OpenAI image timed out after ${Math.round(timeoutMs / 1000)}s (${model}, quality=${quality}). Try OPENAI_IMAGE_QUALITY=medium or a shorter prompt.`,
      );
    }
    const msg = formatFetchError(err);
    if (/fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(msg)) {
      throw new Error(
        `OpenAI image request failed (${model}, quality=${quality}): ${msg}. High quality can take 2+ minutes and exceed server limits — use quality medium.`,
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

export async function generateOpenAIImageDataUrl(
  opts: ImageGenerationOptions,
): Promise<string> {
  const b64 = await generateOpenAIImageB64(opts);
  return `data:image/png;base64,${b64}`;
}
