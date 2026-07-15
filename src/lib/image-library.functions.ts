import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import {
  localBumpImageAssetUsage,
  localInsertImageAsset,
  localMatchImageAsset,
} from "@/lib/local-image-assets";
import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";
import { COURSE_VISUAL_STYLE } from "@/lib/course-visual-style";

async function embed(prompt: string): Promise<number[]> {
  requireOpenAIKey();
  const res = await fetch(`${OPENAI_API}/embeddings`, {
    method: "POST",
    headers: openAIHeaders(),
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: prompt.slice(0, 2000),
    }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.data[0].embedding;
}

async function generateImage(prompt: string, kind: "background" | "element"): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");

  let styled: string;
  const STYLE_BASE = COURSE_VISUAL_STYLE;

  if (kind === "element") {
    styled = `A SINGLE isolated Excalidraw-style hand-drawn doodle of: ${prompt}.

${STYLE_BASE}

CRITICAL for this element:
- Just the subject, centered on PURE WHITE #FFFFFF with generous padding on all sides.
- Sketchy black outline + FLAT PASTEL fill (pick the palette color that fits the subject's role: blue=python/title, green=correct, red=wrong, purple=technical, orange/yellow=hint).
- Friendly, minimal, classroom-slide feel. Slightly uneven lines, rounded corners.
- Absolutely NO background scenery, NO text/labels (unless the subject itself is a labeled card), NO borders, NO frame, NO color swatches, NO watercolor shading, NO cross-hatching, NO drop shadow.
- Square framing. Easy to crop and animate on its own.`;
  } else {
    const titleMatch = prompt.match(/TITLE_PILL:\{color:([a-z]+);text:"([^"]+)"\}/);
    const flowMatch = prompt.match(/FLOW:([^|]+)/);
    const footerMatch = prompt.match(/FOOTER_ROBOT:"([^"]+)"/);
    const moodPrompt = prompt.split("|")[0].trim();

    const title = titleMatch?.[2];
    const titleColor = titleMatch?.[1] ?? "blue";
    const flow = flowMatch?.[1]?.trim().split(/\s*->\s*/).filter(Boolean) ?? [];
    const footer = footerMatch?.[1];

    const titleLine = title
      ? `At the TOP CENTER, draw the title "${title}" in large handwritten marker-style font (black #111), inside a rounded rectangle "pill" with a sketchy black outline and a FLAT PASTEL ${titleColor.toUpperCase()} fill (use the palette in the style guide). Add tiny hand-drawn sparkles/marks beside the pill.`
      : `Leave the top area empty and clean.`;
    const flowLine =
      flow.length >= 2
        ? `DIRECTLY BELOW the title pill, draw a simple hand-drawn horizontal arrow flow: ${flow
            .map((s) => `"${s}"`)
            .join(" → ")}. Short handwritten labels, thin black sketchy arrows, no overlaps.`
        : "";
    const footerLine = footer
      ? `At the BOTTOM CENTER, draw a wide rounded rectangle "pill" with a sketchy black outline and a FLAT PASTEL LAVENDER (#EDE9FE) fill. Inside, on the LEFT, draw a small friendly doodle robot (rounded body, antenna, simple smiling screen face). To the right of the robot, write "${footer}" in handwritten marker-style black text.`
      : `Leave the bottom area empty and clean.`;

    styled = `A 16:9 Excalidraw-style whiteboard EDUCATIONAL INFOGRAPHIC frame.

${STYLE_BASE}

Composition:
${titleLine}

${flowLine}

The LARGE CENTER AREA (roughly 70% of canvas height) MUST be COMPLETELY EMPTY — pure white paper, no drawings, no icons, no shapes, no lines. This empty area will be filled with separate element PNGs later. Do NOT draw anything in the middle.

${footerLine}

Mood context (do not draw literally, only informs color choice): ${moodPrompt}.

Only draw: the title pill at top, optional arrow flow just under it, and optional robot pill at bottom. Nothing else. Keep everything minimal, spacious, and consistent with the pastel Excalidraw palette.`;
  }


  const size = kind === "background" ? "1536x1024" : "1024x1024";

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: styled,
      size,
      n: 1,
      quality: "high",
      background: kind === "element" ? "transparent" : "auto",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI image failed: ${res.status} ${text.slice(0, 400)}`);
  }
  let j: any;
  try { j = JSON.parse(text); } catch {
    throw new Error(`OpenAI image parse failed: ${text.slice(0, 300)}`);
  }
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI image returned no data: ${text.slice(0, 300)}`);
  return `data:image/png;base64,${b64}`;
}

const Input = z.object({
  prompt: z.string().min(1).max(1000),
  kind: z.enum(["background", "element"]),
});

/**
 * Semantic image cache. Embeds prompt, looks for a similar cached image;
 * if found, bumps usage and returns it. Otherwise generates + caches.
 * Requires auth so we can attribute created_by and enforce fair use.
 */
export const findOrGenerateImage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;

    const embedding = await embed(`${data.kind}: ${data.prompt}`);

    const threshold = data.kind === "background" ? 0.85 : 0.9;

    const hit = localMatchImageAsset(embedding, data.kind, threshold);
    if (hit) {
      localBumpImageAssetUsage(hit.id);
      return { dataUrl: hit.public_url, cached: true };
    }

    const dataUrl = await generateImage(data.prompt, data.kind);
    try {
      localInsertImageAsset({
        prompt: data.prompt,
        kind: data.kind,
        public_url: dataUrl,
        embedding,
        created_by: userId,
      });
    } catch (e) {
      console.warn("Failed to cache image asset:", e);
    }
    return { dataUrl, cached: false };
  });
