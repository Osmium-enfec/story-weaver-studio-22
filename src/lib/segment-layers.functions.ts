import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import { replicateFetch, requireReplicateKey } from "@/lib/replicate-client";

/** meta/sam-2 automatic mask generation — community version hash (reference md). */
const SAM2_VERSION =
  "fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83";

const StartInput = z.object({
  imageDataUrl: z.string().min(20),
  pointsPerSide: z.number().int().min(8).max(64).default(32),
  predIouThresh: z.number().min(0).max(1).default(0.9),
  stabilityScoreThresh: z.number().min(0).max(1).default(0.96),
  useM2m: z.boolean().default(true),
  /** Cap returned masks; -1 = unlimited (we still soft-cap client-side). */
  maskLimit: z.number().int().min(-1).max(100).default(24),
});

export interface ReplicateSegment {
  id: string;
  label: string;
  maskUrl: string;
}

type SegmentImageLayersResult =
  | { layers: ReplicateSegment[]; error?: never; fallback?: never }
  | { layers: ReplicateSegment[]; error: string; fallback: true };

function dataUrlToBlob(dataUrl: string): { blob: Blob; filename: string } {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) throw new Error("Invalid image data URL");
  const [, mime, b64] = match;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = mime.split("/")[1]?.split("+")[0] ?? "png";
  return { blob: new Blob([bytes], { type: mime }), filename: `input.${ext}` };
}

/** Upload image bytes to Replicate Files API; return the get URL for predictions. */
async function uploadReplicateFile(dataUrl: string): Promise<string> {
  const { blob, filename } = dataUrlToBlob(dataUrl);
  const fd = new FormData();
  fd.append("content", blob, filename);
  const res = await replicateFetch("/files", { method: "POST", body: fd });
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { urls?: { get?: string }; id?: string };
  if (json.urls?.get) return json.urls.get;
  throw new Error("Upload returned no URL");
}

async function runSam2Prediction(input: Record<string, unknown>): Promise<unknown> {
  const create = await replicateFetch("/predictions", {
    method: "POST",
    body: JSON.stringify({ version: SAM2_VERSION, input }),
  });

  if (create.status === 402) {
    throw new Error(
      "Replicate account has no credit. Enable billing at replicate.com/account/billing.",
    );
  }
  if (!create.ok) {
    throw new Error(`SAM2 start failed [${create.status}]: ${(await create.text()).slice(0, 300)}`);
  }

  const started = (await create.json()) as { id: string };
  const id = started.id;
  if (!id) throw new Error("SAM2 create returned no prediction id");

  const deadline = Date.now() + 180_000;
  let delay = 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    const pr = await replicateFetch(`/predictions/${id}`, { method: "GET" });
    if (!pr.ok) continue;
    const p = (await pr.json()) as {
      status: string;
      output?: { combined_mask?: string; individual_masks?: string[] } | string[] | null;
      error?: string | null;
    };
    if (p.status === "succeeded") return p.output;
    if (p.status === "failed" || p.status === "canceled") {
      throw new Error(`SAM2 ${p.status}: ${p.error ?? "unknown"}`);
    }
  }
  throw new Error("SAM2 prediction timed out");
}

/**
 * Segment a composite into SAM 2 masks (B/W PNG URLs).
 * Follows image-to-layer-sam2-reference.md (community /predictions + version).
 */
export const segmentImageLayers = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => StartInput.parse(d))
  .handler(async ({ data }): Promise<SegmentImageLayersResult> => {
    try {
      requireReplicateKey();
    } catch {
      return {
        layers: [],
        fallback: true,
        error: "REPLICATE_API_KEY not configured.",
      };
    }

    let output: unknown;
    try {
      const imageUrl = await uploadReplicateFile(data.imageDataUrl);
      output = await runSam2Prediction({
        image: imageUrl,
        points_per_side: data.pointsPerSide ?? 32,
        pred_iou_thresh: data.predIouThresh ?? 0.9,
        stability_score_thresh: data.stabilityScoreThresh ?? 0.96,
        use_m2m: data.useM2m ?? true,
        mask_limit: data.maskLimit ?? 24,
      });
    } catch (e: unknown) {
      return {
        layers: [],
        fallback: true,
        error: `SAM2: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    let maskUrls: string[] = [];
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const o = output as { individual_masks?: unknown };
      if (Array.isArray(o.individual_masks)) {
        maskUrls = o.individual_masks.filter((u): u is string => typeof u === "string");
      }
    } else if (Array.isArray(output)) {
      maskUrls = output.filter((u): u is string => typeof u === "string");
    }

    if (maskUrls.length === 0) {
      return {
        layers: [],
        fallback: true,
        error: `SAM2 returned no masks. Raw: ${JSON.stringify(output).slice(0, 300)}`,
      };
    }

    const layers: ReplicateSegment[] = maskUrls.slice(0, 50).map((url, i) => ({
      id: `layer-${i}`,
      label: `Layer ${i + 1}`,
      maskUrl: url,
    }));

    return { layers };
  });

const ProxyInput = z.object({
  url: z.string().url().min(8).max(4000),
});

/** Same-origin proxy: fetch remote mask/image → data URL (avoids canvas taint). */
export const fetchImageAsDataUrl = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => ProxyInput.parse(d))
  .handler(async ({ data }) => {
    const res = await fetch(data.url);
    if (!res.ok) {
      throw new Error(`Fetch image failed (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    return { dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  });
