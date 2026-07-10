import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const GATEWAY = "https://connector-gateway.lovable.dev/replicate/v1";
const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1";

function replicateHeaders() {
  const lov = process.env.LOVABLE_API_KEY;
  const rep = process.env.REPLICATE_API_KEY ?? process.env.LOVABLE_CONNECTOR_REPLICATE_API_KEY;
  if (!lov) throw new Error("LOVABLE_API_KEY missing");
  if (!rep) throw new Error("Replicate connector not linked (REPLICATE_API_KEY missing)");
  return {
    Authorization: `Bearer ${lov}`,
    "X-Connection-Api-Key": rep,
    "Content-Type": "application/json",
  };
}

async function pollPrediction(id: string, maxSec = 300): Promise<any> {
  const headers = replicateHeaders();
  const start = Date.now();
  let delay = 2000;
  while ((Date.now() - start) / 1000 < maxSec) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1000, 8000);
    const res = await fetch(`${GATEWAY}/predictions/${id}`, { headers });
    if (!res.ok) throw new Error(`Poll failed ${res.status}: ${await res.text()}`);
    const j = await res.json();
    if (j.status === "succeeded") return j;
    if (j.status === "failed" || j.status === "canceled") {
      throw new Error(`Prediction ${j.status}: ${j.error ?? "unknown"}`);
    }
  }
  throw new Error("Prediction timed out");
}

async function runReplicate(model: string, input: Record<string, unknown>): Promise<any> {
  const headers = replicateHeaders();
  const res = await fetch(`${GATEWAY}/models/${model}/predictions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input }),
  });
  if (res.status === 402) {
    throw new Error("Replicate account has no credit. Enable billing at https://replicate.com/account/billing.");
  }
  if (!res.ok) throw new Error(`Replicate create failed [${res.status}]: ${await res.text()}`);
  const created = await res.json();
  return pollPrediction(created.id);
}

async function labelElements(imageDataUrl: string): Promise<string[]> {
  const key = process.env.LOVABLE_API_KEY!;
  const res = await fetch(`${AI_GATEWAY}/chat/completions`, {
    method: "POST",
    headers: {
      "Lovable-API-Key": key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Look at this image. List every DISTINCT visual element / object / character / labeled shape you can see, as short lowercase noun phrases separated by commas. Focus on things a designer would want as separate layers (title bar, character, arrow, icon card, footer, robot, etc.). Return ONLY the comma-separated list, no explanation, max 12 items.`,
            },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      max_tokens: 300,
    }),
  });
  if (!res.ok) throw new Error(`Label call failed ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const text: string = j?.choices?.[0]?.message?.content ?? "";
  return text
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase().replace(/^[-*\d.)\s]+/, ""))
    .filter((s) => s.length > 1 && s.length < 60)
    .slice(0, 12);
}

const Input = z.object({
  imageDataUrl: z.string().min(20),
});

export const segmentImageLayers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    // 1. Labels
    const labels = await labelElements(data.imageDataUrl);
    if (labels.length === 0) throw new Error("No labels detected in image");

    // 2. Grounded SAM — one call, all labels
    // schananas/grounded_sam takes: image (url/data), mask_prompt (comma labels)
    const gs = await runReplicate("schananas/grounded_sam", {
      image_url: data.imageDataUrl,
      mask_prompt: labels.join(","),
      negative_mask_prompt: "",
      adjustment_factor: 0,
    });

    // Response shape varies. Log to help debug and be tolerant.
    console.log("[grounded_sam] output keys:", Object.keys(gs?.output ?? {}));

    const output = gs.output;
    // Common shapes:
    //   { masks: [url,...], individual_masks: [url,...], json_data: {...} }
    //   [url, url, ...]  (annotated + masks)
    //   { mask: url, image: url }
    let maskUrls: string[] = [];
    if (Array.isArray(output)) {
      maskUrls = output.filter((u): u is string => typeof u === "string" && u.includes(".png"));
    } else if (output && typeof output === "object") {
      const candidates = [
        (output as any).individual_masks,
        (output as any).masks,
        (output as any).mask_images,
      ];
      for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0) {
          maskUrls = c.filter((u): u is string => typeof u === "string");
          break;
        }
      }
      if (maskUrls.length === 0 && typeof (output as any).mask === "string") {
        maskUrls = [(output as any).mask];
      }
    }

    if (maskUrls.length === 0) {
      throw new Error(`grounded_sam returned no masks. Raw output: ${JSON.stringify(output).slice(0, 400)}`);
    }

    // Pair masks with labels by index (best effort — schananas returns 1 mask per label in order)
    const layers = maskUrls.map((maskUrl, i) => ({
      id: `layer-${i}`,
      label: labels[i] ?? `element-${i + 1}`,
      maskUrl,
    }));

    return { labels, layers, rawOutput: output };
  });
