import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const Input = z.object({
  topic: z.string().min(1).max(2000),
});

/**
 * Generate a single MCQ-style infographic PNG using OpenAI gpt-image-1,
 * laid out to match the `mcq-four-card` mask template so masks reveal
 * each element correctly.
 *
 * Canvas is 1536x1024 (closest supported gpt-image-1 size to the
 * 1659x948 reference used by the template's fractional coordinates).
 */
export const generateMcqImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not configured");

    const prompt = `Hand-drawn Excalidraw-style educational infographic on a PURE WHITE (#FFFFFF) background, landscape 3:2 (1536x1024). Playful sketchy black marker outlines (slightly wobbly), warm pastel fills, small hand-drawn doodles/sparkles as accents. NO photorealism, NO borders around the whole canvas, NO frame.

Compose a MULTIPLE-CHOICE QUESTION laid out TOP-TO-BOTTOM with EXACTLY these 7 elements, arranged in NON-OVERLAPPING horizontal bands. Coordinates are fractions of the canvas from the top-left (canvas = 100% wide × 100% tall). Follow the positions strictly — masks will cover each element by position. Leave clean white gaps between every element; nothing must cross into a neighbouring band.

CRITICAL: Every element must be drawn inside its own rounded-rectangle box/card with a sketchy black outline and a flat pastel fill. The subtitle and any inline text must also sit inside a small rounded pill or box. No floating text or loose icons without a containing box.

1) MAIN TITLE BANNER (the question) — wide rounded rectangle "pill" filled with soft pastel BLUE, thick black sketchy outline, hand-drawn black marker text inside. Position: x=4%, y=3%, width=92%, height=12%.

2) SUBTITLE — small hand-drawn text label inside a rounded rectangle pill with a soft pastel GRAY/BLUE fill, gray-black marker text, thick black sketchy outline. Position: x=10%, y=18%, width=80%, height=7%.

3) OPTION A CARD — tall rounded rectangle, soft pastel YELLOW fill, thick black sketchy outline. Big letter "A" at the top, then the option text, plus a small hand-drawn doodle. Position: x=3%, y=29%, width=21%, height=52%.

4) OPTION B CARD — same style, soft pastel PEACH fill. Position: x=26%, y=29%, width=21%, height=52%.

5) OPTION C CARD — same style, soft pastel GREEN fill. Position: x=49%, y=29%, width=21%, height=52%.

6) OPTION D CARD — same style, soft pastel LAVENDER fill. Position: x=72%, y=29%, width=21%, height=52%.

7) CORRECT ANSWER BANNER — wide rounded rectangle pill, soft pastel MINT fill, thick black outline. "Correct answer: <letter>" in hand-drawn marker + small check-mark doodle. Position: x=4%, y=84%, width=92%, height=13%.

TOPIC / CONTENT to fill in the question, four options, and correct answer: ${data.topic}

Rules: keep the white space between elements clean (no random doodles outside these 7 shapes). Do NOT rearrange the layout. All 4 option cards must be the same height and top-aligned in a single row. Bands MUST NOT overlap — title (3–15%), subtitle (18–25%), cards row (29–81%), answer (84–97%). Use the exact fractional positions above.`;

    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        size: "1536x1024",
        n: 1,
        quality: "high",
        background: "opaque",
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenAI image failed: ${res.status} ${text.slice(0, 400)}`);
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error(`OpenAI image parse failed: ${text.slice(0, 300)}`); }
    const b64 = j?.data?.[0]?.b64_json;
    if (!b64) throw new Error(`OpenAI image returned no data: ${text.slice(0, 300)}`);
    return { dataUrl: `data:image/png;base64,${b64}` };
  });
