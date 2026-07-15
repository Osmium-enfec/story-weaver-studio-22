import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";
import { replicateFetch, requireReplicateKey } from "@/lib/replicate-client";

const Input = z.object({
  imageDataUrl: z.string().min(20),
  labels: z.array(z.string()).optional(),
});

export interface ReplicateSegment {
  id: string;
  label: string;
  maskUrl: string; // full-size white-on-black PNG URL (Replicate CDN)
}

type SegmentImageLayersResult =
  | { layers: ReplicateSegment[]; error?: never; fallback?: never }
  | { layers: ReplicateSegment[]; error: string; fallback: true };

async function gatewayFetch(path: string, init: RequestInit) {
  return replicateFetch(path, init);
}

async function runReplicate(
  owner: string,
  name: string,
  input: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<any> {
  // Try official model endpoint first, fall back to community version endpoint.
  let create = await gatewayFetch(`/models/${owner}/${name}/predictions`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });

  if (create.status === 404) {
    // community: need version hash
    const mv = await gatewayFetch(`/models/${owner}/${name}`, { method: "GET" });
    if (!mv.ok) throw new Error(`Replicate model lookup failed [${mv.status}]: ${await mv.text()}`);
    const meta = await mv.json();
    const version = meta?.latest_version?.id;
    if (!version) throw new Error("Replicate: no latest_version for model");
    create = await gatewayFetch(`/predictions`, {
      method: "POST",
      body: JSON.stringify({ version, input }),
    });
  }

  if (create.status === 402) {
    throw new Error("Replicate account has no credit. Enable billing at replicate.com/account/billing.");
  }
  if (create.status === 429) {
    const body = await create.text();
    throw new Error(`Replicate rate limited: ${body.slice(0, 200)}`);
  }
  if (!create.ok) {
    throw new Error(`Replicate create failed [${create.status}]: ${(await create.text()).slice(0, 300)}`);
  }

  const started = await create.json();
  const id = started.id;
  const deadline = Date.now() + timeoutMs;
  let delay = 2000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1000, 5000);
    const pr = await gatewayFetch(`/predictions/${id}`, { method: "GET" });
    if (!pr.ok) continue;
    const p = await pr.json();
    if (p.status === "succeeded") return p.output;
    if (p.status === "failed" || p.status === "canceled") {
      throw new Error(`Replicate prediction ${p.status}: ${p.error ?? "unknown"}`);
    }
  }
  throw new Error("Replicate prediction timed out");
}

async function discoverLabels(imageDataUrl: string): Promise<string[]> {
  requireOpenAIKey();
  const prompt = `List every distinct visual element/object in this image as short lowercase noun phrases (1-3 words each), comma separated. Include characters, icons, titles/text-blocks, cards, arrows, footer, robots/mascots, etc. Merge tiny sub-parts into their parent. Max 15 items. Output ONLY the comma-separated list, no prose.`;
  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: openAIHeaders(),
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Label discovery failed [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text: string = j?.choices?.[0]?.message?.content ?? "";
  return text
    .replace(/[\n\r]/g, ",")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^[-*•\d.\s]+/, "").replace(/\.$/, ""))
    .filter((s) => s.length > 0 && s.length < 40)
    .slice(0, 15);
}

export const segmentImageLayers = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => Input.parse(d))
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

    // SAM 2 automatic mask generation — segments EVERY distinct region instead
    // of relying on a single text prompt (which collapsed our infographics into
    // a few coarse card outlines). Labels are used only for naming afterwards.
    let output: any;
    try {
      output = await runReplicate(
        "meta",
        "sam-2",
        {
          image: data.imageDataUrl,
          points_per_side: 32,
          pred_iou_thresh: 0.85,
          stability_score_thresh: 0.9,
          use_m2m: true,
          multimask_output: true,
        },
      );
    } catch (e: any) {
      return { layers: [], fallback: true, error: `SAM2: ${e?.message ?? e}` };
    }

    // meta/sam-2 output: { combined_mask, individual_masks: [urls...] }
    let maskUrls: string[] = [];
    if (output && Array.isArray(output.individual_masks)) {
      maskUrls = output.individual_masks.filter((u: any) => typeof u === "string");
    } else if (Array.isArray(output)) {
      maskUrls = output.filter((u) => typeof u === "string");
    }

    if (maskUrls.length === 0) {
      return {
        layers: [],
        fallback: true,
        error: `SAM2 returned no masks. Raw: ${JSON.stringify(output).slice(0, 300)}`,
      };
    }

    const capped = maskUrls.slice(0, 50);
    const providedLabels = data.labels?.map((l) => l.toLowerCase().trim()).filter(Boolean) ?? [];

    const layers: ReplicateSegment[] = capped.map((url, i) => ({
      id: `layer-${i}`,
      label: providedLabels[i] ?? `region-${i + 1}`,
      maskUrl: url,
    }));

    return { layers };
  });
