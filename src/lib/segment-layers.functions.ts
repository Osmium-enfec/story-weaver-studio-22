import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const Input = z.object({
  imageDataUrl: z.string().min(20),
});

// Gemini returns items shaped like:
//   { box_2d: [ymin, xmin, ymax, xmax], mask: "data:image/png;base64,...", label: "..." }
// where box_2d is normalized to 0-1000 and mask is a small PNG sized to that bbox.
export interface GeminiSegment {
  id: string;
  label: string;
  // normalized 0..1
  box: { x: number; y: number; w: number; h: number };
  maskDataUrl: string; // bbox-sized white-on-black PNG
}

type SegmentImageLayersResult =
  | { layers: GeminiSegment[]; error?: never; fallback?: never }
  | { layers: GeminiSegment[]; error: string; fallback: true };

export const segmentImageLayers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }): Promise<SegmentImageLayersResult> => {
    const aiGateway = "https://ai.gateway.lovable.dev/v1";
    const stripCodeFence = (text: string): string => {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      return (match ? match[1] : text).trim();
    };
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const prompt = `Give the segmentation masks for every distinct visual element in this image (characters, icons, titles, cards, arrows, footer, robots, etc.).
Output a JSON list where each entry has:
- "box_2d": [ymin, xmin, ymax, xmax] normalized to 0-1000
- "mask": a base64 PNG data URL of the mask (white=object, black=background), sized to the bbox
- "label": a short lowercase descriptive noun phrase
Return ONLY the JSON array, no prose. Max 15 items. Prefer merging tiny sub-parts into their parent element.`;

    let res: Response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try {
        res = await fetch(`${aiGateway}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Lovable-API-Key": key,
            "X-Lovable-AIG-SDK": "direct-fetch",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-pro",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: data.imageDataUrl } },
                ],
              },
            ],
          }),
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      console.error("Gemini segmentation fetch failed", error);
      return {
        layers: [],
        fallback: true,
        error:
          error instanceof Error && error.name === "AbortError"
            ? "Gemini segmentation timed out. Try a smaller image or retry in a moment."
            : "Could not reach Lovable AI for segmentation. Please retry in a moment.",
      };
    }

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429) {
        return { layers: [], fallback: true, error: "Lovable AI is rate limited. Retry in a moment." };
      }
      if (res.status === 402) {
        return {
          layers: [],
          fallback: true,
          error: "Lovable AI credits are exhausted. Add credits in workspace settings.",
        };
      }
      return {
        layers: [],
        fallback: true,
        error: `Gemini segmentation failed [${res.status}]: ${body.slice(0, 400)}`,
      };
    }

    let j: any;
    try {
      j = await res.json();
    } catch {
      return {
        layers: [],
        fallback: true,
        error: "Gemini returned an unreadable response. Please retry in a moment.",
      };
    }
    const text: string = j?.choices?.[0]?.message?.content ?? "";
    const cleaned = stripCodeFence(text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Try to extract the first JSON array substring
      const m = cleaned.match(/\[[\s\S]*\]/);
      if (!m) {
        return {
          layers: [],
          fallback: true,
          error: `Could not parse Gemini output: ${text.slice(0, 300)}`,
        };
      }
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return {
          layers: [],
          fallback: true,
          error: `Could not parse Gemini output: ${text.slice(0, 300)}`,
        };
      }
    }

    if (!Array.isArray(parsed)) {
      return { layers: [], fallback: true, error: "Gemini did not return a JSON array" };
    }

    const layers: GeminiSegment[] = [];
    parsed.forEach((item: any, i: number) => {
      const box = item?.box_2d;
      const mask = item?.mask;
      const label = String(item?.label ?? `element-${i + 1}`).toLowerCase().trim();
      if (!Array.isArray(box) || box.length !== 4) return;
      if (typeof mask !== "string" || !mask.startsWith("data:image")) return;
      const [ymin, xmin, ymax, xmax] = box.map(Number);
      if ([ymin, xmin, ymax, xmax].some((n) => !Number.isFinite(n))) return;
      layers.push({
        id: `layer-${i}`,
        label,
        box: {
          x: xmin / 1000,
          y: ymin / 1000,
          w: Math.max(0, xmax - xmin) / 1000,
          h: Math.max(0, ymax - ymin) / 1000,
        },
        maskDataUrl: mask,
      });
    });

    if (layers.length === 0) {
      return {
        layers: [],
        fallback: true,
        error: `No usable segments in Gemini response. Raw: ${text.slice(0, 300)}`,
      };
    }

    return { layers };
  });
