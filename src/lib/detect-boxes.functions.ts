import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import { replicateFetch, requireReplicateKey } from "@/lib/replicate-client";
import { bboxIou, dropMegaWrapperBoxes, filterOutNestedBoxes } from "@/lib/bbox-utils";

const Input = z.object({
  imageDataUrl: z.string().min(20),
  boxThreshold: z.number().min(0.05).max(0.9).optional(),
  textThreshold: z.number().min(0.05).max(0.9).optional(),
});

export interface DetectedBox {
  id: string;
  bbox: { x: number; y: number; w: number; h: number }; // normalized 0..1
  confidence: number;
}

export type DetectBoxesResult =
  | { boxes: DetectedBox[]; error?: never; fallback?: never }
  | { boxes: DetectedBox[]; error: string; fallback: true };

async function uploadDataUrlToReplicate(dataUrl: string): Promise<string> {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("uploadDataUrlToReplicate: expected data URL");
  const mime = m[1];
  const bytes = Buffer.from(m[2], "base64");
  const form = new FormData();
  form.append("content", new Blob([bytes], { type: mime }), "detect.png");
  const res = await replicateFetch("/files", { method: "POST", body: form });
  if (!res.ok) throw new Error(`Replicate upload failed [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  const url = j?.urls?.get;
  if (!url) throw new Error("Replicate upload returned no url");
  return url as string;
}

async function runGroundingDino(imageUrl: string, boxThreshold: number, textThreshold: number) {
  const query = "box . card . panel . rounded rectangle . banner . pill";
  const mv = await replicateFetch(`/models/adirik/grounding-dino`, { method: "GET" });
  if (!mv.ok) throw new Error(`grounding-dino model lookup [${mv.status}]`);
  const version = (await mv.json())?.latest_version?.id;
  if (!version) throw new Error("grounding-dino: no latest_version");

  const create = await replicateFetch(`/predictions`, {
    method: "POST",
    body: JSON.stringify({
      version,
      input: {
        image: imageUrl,
        query,
        box_threshold: boxThreshold,
        text_threshold: textThreshold,
        show_visualisation: false,
      },
    }),
  });
  if (create.status === 402) throw new Error("Replicate has no credit.");
  if (!create.ok) throw new Error(`GroundingDINO create [${create.status}]: ${(await create.text()).slice(0, 200)}`);

  let pred = await create.json();
  const deadline = Date.now() + 120_000;
  while ((pred.status === "starting" || pred.status === "processing") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await replicateFetch(`/predictions/${pred.id}`, { method: "GET" });
    if (!poll.ok) continue;
    pred = await poll.json();
  }
  if (pred.status !== "succeeded") {
    throw new Error(`GroundingDINO ${pred.status}: ${JSON.stringify(pred.error ?? "").slice(0, 200)}`);
  }
  return pred.output;
}

function iou(a: { x: number; y: number; w: number; h: number }, b: typeof a) {
  return bboxIou(a, b);
}

export const detectBoxesInImage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }): Promise<DetectBoxesResult> => {
    try {
      requireReplicateKey();
    } catch {
      return { boxes: [], fallback: true, error: "REPLICATE_API_KEY not configured." };
    }

    let imageUrl = data.imageDataUrl;
    if (imageUrl.startsWith("data:")) {
      try {
        imageUrl = await uploadDataUrlToReplicate(imageUrl);
      } catch (e: any) {
        return { boxes: [], fallback: true, error: `upload: ${e?.message ?? String(e)}` };
      }
    }

    const boxThreshold = data.boxThreshold ?? 0.22;
    const textThreshold = data.textThreshold ?? 0.2;

    let output: any;
    try {
      output = await runGroundingDino(imageUrl, boxThreshold, textThreshold);
    } catch (e: any) {
      return { boxes: [], fallback: true, error: e?.message ?? String(e) };
    }

    let detections: any[] = [];
    let imgW = 0;
    let imgH = 0;
    if (Array.isArray(output)) detections = output;
    else if (output && typeof output === "object") {
      detections = output.detections || output.result || output.predictions || [];
      imgW = Number(output.image_width || output.width || 0);
      imgH = Number(output.image_height || output.height || 0);
    }

    if (detections.length < 3 && boxThreshold >= 0.2) {
      try {
        const output2 = await runGroundingDino(imageUrl, 0.16, 0.15);
        let extra: any[] = [];
        if (Array.isArray(output2)) extra = output2;
        else if (output2 && typeof output2 === "object") {
          extra = output2.detections || output2.result || output2.predictions || [];
          if (!imgW) imgW = Number(output2.image_width || output2.width || 0);
          if (!imgH) imgH = Number(output2.image_height || output2.height || 0);
        }
        detections = [...detections, ...extra];
      } catch {
        /* keep first pass */
      }
    }

    const raw: DetectedBox[] = [];
    for (const d of detections) {
      const b = d.bbox || d.box || d.bounding_box;
      if (!Array.isArray(b) || b.length < 4) continue;
      let [x1, y1, x2, y2] = b.map(Number);
      const looksPixel = Math.max(x1, y1, x2, y2) > 1.5;
      if (looksPixel && imgW && imgH) {
        x1 /= imgW;
        x2 /= imgW;
        y1 /= imgH;
        y2 /= imgH;
      } else if (looksPixel) {
        x1 /= 1536;
        x2 /= 1536;
        y1 /= 1024;
        y2 /= 1024;
      }
      const nx = Math.max(0, Math.min(1, Math.min(x1, x2)));
      const ny = Math.max(0, Math.min(1, Math.min(y1, y2)));
      const nw = Math.max(0, Math.min(1 - nx, Math.abs(x2 - x1)));
      const nh = Math.max(0, Math.min(1 - ny, Math.abs(y2 - y1)));
      if (nw < 0.04 || nh < 0.03) continue;
      // Single-box hard limit — full-image false positives are filtered again below.
      if (nw * nh > 0.48) continue;
      raw.push({
        id: `box-${raw.length}`,
        bbox: { x: nx, y: ny, w: nw, h: nh },
        confidence: Number(d.confidence || d.score || 0),
      });
    }

    // Drop near-duplicate detections only (keep all separate sibling boxes).
    raw.sort((a, b) => b.confidence - a.confidence);
    const kept: DetectedBox[] = [];
    for (const cand of raw) {
      const dup = kept.some((k) => iou(cand.bbox, k.bbox) > 0.55);
      if (!dup) kept.push(cand);
    }

    const nested = filterOutNestedBoxes(kept);
    const filtered = dropMegaWrapperBoxes(nested);

    filtered.forEach((b, i) => (b.id = `box-${i}`));
    return { boxes: filtered };
  });
