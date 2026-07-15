import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";
import { normalizeDetectorBbox } from "@/lib/bbox-normalize";

const AuditInput = z.object({
  imageDataUrl: z.string().min(20),
  sceneContext: z.string().min(1),
  title: z.string().optional(),
});

export interface BoxAuditResult {
  expectedBoxCount: number;
  boxLabels: string[];
  missingConcepts: string[];
}

export interface VisionDetectedBox {
  label: string;
  bbox: { x: number; y: number; w: number; h: number };
}

const VisionDetectInput = z.object({
  imageDataUrl: z.string().min(20),
});

/** GPT-4o vision: bbox of every hand-drawn box/card visible in the composite. */
export const visionDetectBoxes = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => VisionDetectInput.parse(d))
  .handler(async ({ data }): Promise<{ boxes: VisionDetectedBox[] }> => {
    try {
      requireOpenAIKey();
    } catch {
      return { boxes: [] };
    }

    const sys = `You detect every hand-drawn bordered rectangle in infographic images.

Return ONLY JSON:
{
  "boxes": [
    { "label": "2-5 word label of text inside the region", "bbox": [x0, y0, x1, y1] }
  ]
}

Rules:
- bbox: normalized 0..1 decimals, top-left origin, [x0,y0,x1,y1] corners that include the full hand-drawn border stroke.
- ONE bbox per bordered region. Title, subtitle, each data card, hub panel, footer strip = separate boxes.
- NEVER merge multiple bordered cards into one bbox. NEVER return one giant box wrapping the whole layout.
- Include every bordered sibling on the white canvas: title bar, subtitle, each card in a grid, side panel, footer.
- Skip bare icons, arrows, and connector lines (no border = no box).
- Ignore only an outer colored frame at the image edge (if present).`;

    try {
      const res = await fetch(`${OPENAI_API}/chat/completions`, {
        method: "POST",
        headers: openAIHeaders(),
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: sys },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "List every separate hand-drawn bordered box/card on the white canvas. Each bordered region gets its own bbox. Do not merge cards into one box.",
                },
                {
                  type: "image_url",
                  image_url: { url: data.imageDataUrl, detail: "high" },
                },
              ],
            },
          ],
          response_format: { type: "json_object" },
          max_tokens: 2000,
        }),
      });
      if (!res.ok) return { boxes: [] };
      const j = await res.json();
      const parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
      const arr = Array.isArray(parsed.boxes) ? parsed.boxes : [];
      const boxes: VisionDetectedBox[] = [];
      for (const e of arr) {
        const bb = Array.isArray(e?.bbox) ? e.bbox.map(Number) : null;
        if (!bb || bb.length < 4) continue;
        const bbox = normalizeDetectorBbox(bb);
        if (!bbox || bbox.w * bbox.h > 0.85) continue;
        boxes.push({
          label: String(e?.label ?? "").trim() || "box",
          bbox,
        });
      }
      return { boxes };
    } catch (e: unknown) {
      console.warn("[vision-detect]", e instanceof Error ? e.message : e);
      return { boxes: [] };
    }
  });

/** GPT-4o vision: count hand-drawn card/box regions the scene should reveal. */
export const auditCompositeBoxes = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => AuditInput.parse(d))
  .handler(async ({ data }): Promise<BoxAuditResult> => {
    requireOpenAIKey();
    const sys = `You audit an image for sequential box-by-box reveal.

Return ONLY JSON:
{
  "expectedBoxCount": number,
  "boxLabels": ["short label for each outer box in top-to-bottom reading order"],
  "missingConcepts": ["concepts from the scene text with no dedicated outer box"]
}

Rules:
- Scope: white / light canvas interior only — ignore any outer colored border/frame.
- Count EVERY outermost hand-drawn bordered region on that white canvas (all sibling parent containers).
- Do NOT count a region mostly inside another bordered region — count the parent only.
- Do NOT count the canvas edge or full-canvas wrapper as a box.
- Use the narration to verify major ideas each have an outer box on white; ignore inner sub-regions inside a parent.
- missingConcepts: important narration terms not covered by any outer box label.`;

    const res = await fetch(`${OPENAI_API}/chat/completions`, {
      method: "POST",
      headers: openAIHeaders(),
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Scene title: ${data.title ?? "(none)"}\nScene narration:\n${data.sceneContext}\n\nHow many outermost reveal boxes are on the white canvas? List every parent container on white (not the outer frame).`,
              },
              { type: "image_url", image_url: { url: data.imageDataUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 800,
      }),
    });
    if (!res.ok) {
      throw new Error(`box audit failed: ${res.status}`);
    }
    const j = await res.json();
    const raw = j.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    return {
      expectedBoxCount: Math.max(1, Number(parsed.expectedBoxCount) || 1),
      boxLabels: Array.isArray(parsed.boxLabels) ? parsed.boxLabels.map(String) : [],
      missingConcepts: Array.isArray(parsed.missingConcepts)
        ? parsed.missingConcepts.map(String)
        : [],
    };
  });
