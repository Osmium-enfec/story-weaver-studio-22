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

    const prompt = `Hand-drawn Excalidraw-style educational infographic on a PURE WHITE (#FFFFFF) background, 16:9 landscape. Playful sketchy black marker outlines (slightly wobbly), warm pastel fills, small hand-drawn doodles/sparkles as accents. NO photorealism, NO borders around the whole canvas, NO frame.

Compose a MULTIPLE-CHOICE QUESTION layout with EXACTLY these 7 elements, positioned as specified (coordinates are fractions of the canvas from the top-left; canvas = 100% x 100%):

1) MAIN TITLE BANNER — a large rounded rectangle "pill" filled with soft pastel BLUE, thick black sketchy outline. Inside: the question title in bold hand-drawn black marker font. Position: x=20%, y=59%, width=45%, height=16%.

2) SUBTITLE — small hand-drawn text label (no pill), gray-black marker font. Position: x=25%, y=23%, width=11%, height=5%.

3) OPTION A CARD — tall rounded rectangle card, soft pastel YELLOW fill, thick black sketchy outline. Inside: a big letter "A" at top, then the option text, plus a small hand-drawn doodle illustration. Position: x=7%, y=33%, width=17%, height=62%.

4) OPTION B CARD — same style, soft pastel PEACH fill. Big letter "B", option text, small doodle. Position: x=29%, y=33%, width=20%, height=48%.

5) OPTION C CARD — same style, soft pastel GREEN fill. Big letter "C", option text, small doodle. Position: x=51%, y=33%, width=20%, height=48%.

6) OPTION D CARD — same style, soft pastel LAVENDER fill. Big letter "D", option text, small doodle. Position: x=73%, y=33%, width=19%, height=48%.

7) CORRECT ANSWER BANNER — wide rounded rectangle pill at bottom, soft pastel MINT fill, thick black outline. Inside: "Correct answer: <letter>" in hand-drawn black marker font, plus a small check-mark doodle. Position: x=19%, y=83%, width=62%, height=12%.

TOPIC / CONTENT to fill in for the question, options, and answer: ${data.topic}

Rules: keep the empty white background between elements clean (no random doodles outside these 7 elements). Respect the positions exactly so masks can cover each element. Use consistent warm pastel palette. All text is hand-drawn marker style, easily readable.`;

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
