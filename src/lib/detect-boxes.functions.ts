import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const Input = z.object({
  imageDataUrl: z.string().min(20),
});

export interface DetectedBox {
  id: string;
  bbox: { x: number; y: number; w: number; h: number }; // normalized 0..1
  confidence: number;
}

export type DetectBoxesResult =
  | { boxes: DetectedBox[]; error?: never; fallback?: never }
  | { boxes: DetectedBox[]; error: string; fallback: true };

const GATEWAY = "https://connector-gateway.lovable.dev/replicate/v1";

async function gw(path: string, init: RequestInit, keys: { lovable: string; rep: string }) {
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

async function runGroundingDino(imageUrl: string, keys: { lovable: string; rep: string }) {
  const query = "box . card . panel . rounded rectangle . banner . pill";
  // resolve version
  const mv = await gw(`/models/adirik/grounding-dino`, { method: "GET" }, keys);
  if (!mv.ok) throw new Error(`grounding-dino model lookup [${mv.status}]`);
  const meta = await mv.json();
  const version = meta?.latest_version?.id;
  if (!version) throw new Error("grounding-dino: no latest_version");

  const create = await gw(`/predictions`, {
    method: "POST",
    body: JSON.stringify({
      version,
      input: {
        image: imageUrl,
        query,
        box_threshold: 0.22,
        text_threshold: 0.2,
        show_visualisation: false,
      },
    }),
  }, keys);
  if (create.status === 402) throw new Error("Replicate has no credit.");
  if (!create.ok) throw new Error(`GroundingDINO create [${create.status}]: ${(await create.text()).slice(0, 200)}`);
  let pred = await create.json();
  const deadline = Date.now() + 120_000;
  while ((pred.status === "starting" || pred.status === "processing") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await gw(`/predictions/${pred.id}`, { method: "GET" }, keys);
    if (!poll.ok) continue;
    pred = await poll.json();
  }
  if (pred.status !== "succeeded") throw new Error(`GroundingDINO ${pred.status}: ${JSON.stringify(pred.error ?? "").slice(0, 200)}`);
  return pred.output;
}

function iou(a: { x: number; y: number; w: number; h: number }, b: typeof a) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = a.w * a.h + b.w * b.h - inter;
  return ua > 0 ? inter / ua : 0;
}

export const detectBoxesInImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }): Promise<DetectBoxesResult> => {
    const lovable = process.env.LOVABLE_API_KEY;
    const rep = process.env.LOVABLE_CONNECTOR_REPLICATE_API_KEY ?? process.env.REPLICATE_API_KEY;
    if (!lovable) throw new Error("LOVABLE_API_KEY missing");
    if (!rep) return { boxes: [], fallback: true, error: "Replicate connector not linked." };

    let output: any;
    try {
      output = await runGroundingDino(data.imageDataUrl, { lovable, rep });
    } catch (e: any) {
      return { boxes: [], fallback: true, error: e?.message ?? String(e) };
    }

    let detections: any[] = [];
    let imgW = 0, imgH = 0;
    if (Array.isArray(output)) detections = output;
    else if (output && typeof output === "object") {
      detections = output.detections || output.result || output.predictions || [];
      imgW = Number(output.image_width || output.width || 0);
      imgH = Number(output.image_height || output.height || 0);
    }

    const raw: DetectedBox[] = [];
    for (const d of detections) {
      const b = d.bbox || d.box || d.bounding_box;
      if (!Array.isArray(b) || b.length < 4) continue;
      let [x1, y1, x2, y2] = b.map(Number);
      const looksPixel = Math.max(x1, y1, x2, y2) > 1.5;
      if (looksPixel && imgW && imgH) { x1 /= imgW; x2 /= imgW; y1 /= imgH; y2 /= imgH; }
      else if (looksPixel) { x1 /= 1536; x2 /= 1536; y1 /= 1024; y2 /= 1024; }
      const nx = Math.max(0, Math.min(1, Math.min(x1, x2)));
      const ny = Math.max(0, Math.min(1, Math.min(y1, y2)));
      const nw = Math.max(0, Math.min(1 - nx, Math.abs(x2 - x1)));
      const nh = Math.max(0, Math.min(1 - ny, Math.abs(y2 - y1)));
      if (nw < 0.04 || nh < 0.03) continue;
      // Skip full-image-ish detections.
      if (nw * nh > 0.9) continue;
      raw.push({
        id: `box-${raw.length}`,
        bbox: { x: nx, y: ny, w: nw, h: nh },
        confidence: Number(d.confidence || d.score || 0),
      });
    }

    // Sort by confidence desc, then NMS at IoU 0.55 — prefer outer boxes over
    // ones nested inside them by keeping the larger of any overlapping pair.
    raw.sort((a, b) => b.confidence - a.confidence);
    const kept: DetectedBox[] = [];
    for (const cand of raw) {
      let drop = false;
      for (let i = 0; i < kept.length; i++) {
        const k = kept[i];
        const ov = iou(cand.bbox, k.bbox);
        if (ov > 0.55) {
          // keep larger
          if (cand.bbox.w * cand.bbox.h > k.bbox.w * k.bbox.h) kept[i] = cand;
          drop = true;
          break;
        }
        // Also drop if this box is mostly INSIDE a kept larger one (nested inner element).
        const interX = Math.max(0, Math.min(cand.bbox.x + cand.bbox.w, k.bbox.x + k.bbox.w) - Math.max(cand.bbox.x, k.bbox.x));
        const interY = Math.max(0, Math.min(cand.bbox.y + cand.bbox.h, k.bbox.y + k.bbox.h) - Math.max(cand.bbox.y, k.bbox.y));
        const interArea = interX * interY;
        const candArea = cand.bbox.w * cand.bbox.h;
        const kArea = k.bbox.w * k.bbox.h;
        if (interArea / candArea > 0.8 && candArea < kArea) { drop = true; break; }
      }
      if (!drop) kept.push(cand);
    }

    // Reindex ids.
    kept.forEach((b, i) => (b.id = `box-${i}`));
    return { boxes: kept };
  });
