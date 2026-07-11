import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const Input = z.object({
  imageDataUrl: z.string().min(20),
});

export interface ReplicateSegment {
  id: string;
  label: string;
  maskUrl: string; // full-size white-on-black PNG URL (Replicate CDN)
}

type SegmentImageLayersResult =
  | { layers: ReplicateSegment[]; error?: never; fallback?: never }
  | { layers: ReplicateSegment[]; error: string; fallback: true };

const GATEWAY = "https://connector-gateway.lovable.dev/replicate/v1";

async function gatewayFetch(path: string, init: RequestInit, keys: { lovable: string; rep: string }) {
  return fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${keys.lovable}`,
      "X-Connection-Api-Key": keys.rep,
      "Content-Type": "application/json",
    },
  });
}

async function runReplicate(
  owner: string,
  name: string,
  input: Record<string, unknown>,
  keys: { lovable: string; rep: string },
  timeoutMs = 180_000,
): Promise<any> {
  // Try official model endpoint first, fall back to community version endpoint.
  let create = await gatewayFetch(`/models/${owner}/${name}/predictions`, {
    method: "POST",
    body: JSON.stringify({ input }),
  }, keys);

  if (create.status === 404) {
    // community: need version hash
    const mv = await gatewayFetch(`/models/${owner}/${name}`, { method: "GET" }, keys);
    if (!mv.ok) throw new Error(`Replicate model lookup failed [${mv.status}]: ${await mv.text()}`);
    const meta = await mv.json();
    const version = meta?.latest_version?.id;
    if (!version) throw new Error("Replicate: no latest_version for model");
    create = await gatewayFetch(`/predictions`, {
      method: "POST",
      body: JSON.stringify({ version, input }),
    }, keys);
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
    const pr = await gatewayFetch(`/predictions/${id}`, { method: "GET" }, keys);
    if (!pr.ok) continue;
    const p = await pr.json();
    if (p.status === "succeeded") return p.output;
    if (p.status === "failed" || p.status === "canceled") {
      throw new Error(`Replicate prediction ${p.status}: ${p.error ?? "unknown"}`);
    }
  }
  throw new Error("Replicate prediction timed out");
}

async function discoverLabels(
  imageDataUrl: string,
  lovableKey: string,
): Promise<string[]> {
  const prompt = `List every distinct visual element/object in this image as short lowercase noun phrases (1-3 words each), comma separated. Include characters, icons, titles/text-blocks, cards, arrows, footer, robots/mascots, etc. Merge tiny sub-parts into their parent. Max 15 items. Output ONLY the comma-separated list, no prose.`;
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Lovable-API-Key": lovableKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
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
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }): Promise<SegmentImageLayersResult> => {
    const lovable = process.env.LOVABLE_API_KEY;
    const rep = process.env.LOVABLE_CONNECTOR_REPLICATE_API_KEY ?? process.env.REPLICATE_API_KEY;
    if (!lovable) throw new Error("LOVABLE_API_KEY missing");
    if (!rep) {
      return {
        layers: [],
        fallback: true,
        error: "Replicate connector not linked. Connect Replicate in project connectors.",
      };
    }
    const keys = { lovable, rep };

    let labels: string[] = [];
    try {
      labels = await discoverLabels(data.imageDataUrl, lovable);
    } catch (e: any) {
      return { layers: [], fallback: true, error: `Label discovery: ${e?.message ?? e}` };
    }
    if (labels.length === 0) {
      return { layers: [], fallback: true, error: "No labels discovered in image" };
    }

    // Grounded-SAM: text-prompted detection + SAM masks. Returns per-label masks.
    // schananas/grounded_sam takes comma-separated `mask_prompt` and returns
    // { masks: [urls...], detections: [urls...] } or similar. We ask for masks.
    let output: any;
    try {
      output = await runReplicate(
        "schananas",
        "grounded_sam",
        {
          image: data.imageDataUrl,
          mask_prompt: labels.join(","),
          negative_mask_prompt: "",
          adjustment_factor: 0,
        },
        keys,
      );
    } catch (e: any) {
      return { layers: [], fallback: true, error: e?.message ?? String(e) };
    }

    // Output shape: usually an array of mask image URLs, one per prompt (in order).
    // Sometimes an object { masks: [...] }. Normalize.
    let maskUrls: string[] = [];
    if (Array.isArray(output)) {
      maskUrls = output.filter((u) => typeof u === "string");
    } else if (output && Array.isArray(output.masks)) {
      maskUrls = output.masks.filter((u: any) => typeof u === "string");
    } else if (typeof output === "string") {
      maskUrls = [output];
    }

    if (maskUrls.length === 0) {
      return {
        layers: [],
        fallback: true,
        error: `Grounded-SAM returned no masks. Raw: ${JSON.stringify(output).slice(0, 300)}`,
      };
    }

    const layers: ReplicateSegment[] = maskUrls.map((url, i) => ({
      id: `layer-${i}`,
      label: labels[i] ?? `element-${i + 1}`,
      maskUrl: url,
    }));

    return { layers };
  });
