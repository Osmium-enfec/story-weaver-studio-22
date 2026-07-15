import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import type { QuestionKind } from "@/lib/compose-scene";
import { QUESTION_TEMPLATE_ID } from "@/lib/compose-question";

const Input = z.object({
  kind: z.enum(["mcq", "msq"]),
  topic: z.string().min(1).max(2000),
});

const SHARED_LAYOUT = `Hand-drawn Excalidraw-style educational infographic on a PURE WHITE (#FFFFFF) background, landscape 3:2 (1536x1024). Playful sketchy black marker outlines (slightly wobbly), warm pastel fills, small hand-drawn doodles/sparkles as accents. NO photorealism, NO borders around the whole canvas, NO frame.

Compose the question laid out TOP-TO-BOTTOM with EXACTLY these 7 elements, arranged in NON-OVERLAPPING horizontal bands. Coordinates are fractions of the canvas from the top-left (canvas = 100% wide × 100% tall). Follow the positions strictly — masks will cover each element by position. Leave clean white gaps between every element; nothing must cross into a neighbouring band.

CRITICAL: Every element must be drawn inside its own HAND-DRAWN IMPERFECT box — wobbly wavy rounded rectangle, sketchy black marker outline (NOT a perfect rectangle), slightly crooked corners, small wiggles on each side, flat pastel fill. The subtitle and any inline text must also sit inside a small hand-drawn wobbly pill/box. No floating text or loose icons without a containing hand-drawn box.

1) MAIN TITLE BANNER (the question) — wide rounded rectangle "pill" filled with soft pastel BLUE, thick black sketchy outline, hand-drawn black marker text inside. Position: x=4%, y=3%, width=92%, height=12%.

2) SUBTITLE — small hand-drawn text label inside a rounded rectangle pill with a soft pastel GRAY/BLUE fill, gray-black marker text, thick black sketchy outline. Position: x=10%, y=18%, width=80%, height=7%.

3) OPTION A CARD — tall rounded rectangle, soft pastel YELLOW fill, thick black sketchy outline. Big letter "A" at the top, then the option text, plus a small hand-drawn doodle. Position: x=3%, y=29%, width=21%, height=52%.

4) OPTION B CARD — same style, soft pastel PEACH fill. Position: x=26%, y=29%, width=21%, height=52%.

5) OPTION C CARD — same style, soft pastel GREEN fill. Position: x=49%, y=29%, width=21%, height=52%.

6) OPTION D CARD — same style, soft pastel LAVENDER fill. Position: x=72%, y=29%, width=21%, height=52%.

7) ANSWER BANNER — wide rounded rectangle pill at the bottom. Position: x=4%, y=84%, width=92%, height=13%.

Rules: keep the white space between elements clean (no random doodles outside these 7 shapes). Do NOT rearrange the layout. All 4 option cards must be the same height and top-aligned in a single row. Bands MUST NOT overlap — title (3–15%), subtitle (18–25%), cards row (29–81%), answer (84–97%). Use the exact fractional positions above.`;

function buildPrompt(kind: QuestionKind, topic: string): string {
  if (kind === "mcq") {
    return `${SHARED_LAYOUT}

This is a MULTIPLE-CHOICE question (pick ONE correct answer). Draw empty radio-circle doodles (small hand-drawn circles) beside each option letter — NOT checkboxes.

7) ANSWER BANNER — soft pastel MINT fill, thick black outline. "Correct answer: <letter>" in hand-drawn marker + small check-mark doodle.

TOPIC / CONTENT to fill in the question, four options, and the single correct answer: ${topic}`;
  }

  return `${SHARED_LAYOUT}

This is a MULTIPLE-SELECT question (pick TWO OR MORE correct answers). Draw empty checkbox doodles (small hand-drawn squares) beside each option letter — NOT radio circles.

7) ANSWER BANNER — soft pastel MINT fill, thick black outline. "Correct answers: <letters>" listing ALL correct options (e.g. "A, C, D") in hand-drawn marker + small check-mark doodles.

TOPIC / CONTENT to fill in the question, four options, and which options are correct (at least two): ${topic}`;
}

async function generateQuestionImage(kind: QuestionKind, topic: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: buildPrompt(kind, topic),
      size: "1536x1024",
      n: 1,
      quality: "high",
      background: "opaque",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI image failed: ${res.status} ${text.slice(0, 400)}`);
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI image parse failed: ${text.slice(0, 300)}`);
  }
  const b64 = (j as { data?: { b64_json?: string }[] })?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI image returned no data: ${text.slice(0, 300)}`);
  return `data:image/png;base64,${b64}`;
}

/** @deprecated Use generateQuestionImage */
export const generateMcqImage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ topic: z.string().min(1).max(2000) }).parse(d))
  .handler(async ({ data }) => ({
    dataUrl: await generateQuestionImage("mcq", data.topic),
    templateId: QUESTION_TEMPLATE_ID.mcq,
  }));

export const generateQuestionImageFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => ({
    dataUrl: await generateQuestionImage(data.kind, data.topic),
    templateId: QUESTION_TEMPLATE_ID[data.kind],
    kind: data.kind,
  }));
