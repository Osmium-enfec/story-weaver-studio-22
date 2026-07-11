import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const Input = z.object({
  prompt: z.string().min(3).max(2000),
});

const STYLE_BASE = `EXCALIDRAW EDUCATIONAL INFOGRAPHIC STYLE:
- Pure white background #FFFFFF. No textures, no gradients.
- Hand-drawn sketchy black outlines #111111, 2-5px, slightly wobbly, rounded corners.
- Flat PASTEL fills only (no watercolor, no cross-hatching, no photorealism, no 3D):
  blue #3B82F6 / #DBEAFE, green #22C55E / #DCFCE7, red #EF4444 / #FEE2E2,
  purple #8B5CF6 / #EDE9FE, orange/yellow #F59E0B / #FEF3C7.
- Handwritten marker-style font for any text. Short phrases only.
- Doodle icons only (check, X, star, lightbulb, robot, laptop, code window, arrow, speech bubble, tag).
- Generous white space. No overlapping arrows / text / icons.`;

async function planLabels(userPrompt: string, lovableKey: string): Promise<string[]> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Lovable-API-Key": lovableKey,
      "X-Lovable-AIG-SDK": "direct-fetch",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-5",
      messages: [
        {
          role: "system",
          content:
            "You plan Excalidraw-style educational infographics. Output ONLY a JSON array of 3-10 short lowercase noun phrases (1-3 words) naming every DISTINCT visual element that should appear in the image (title banner, cards, mascots, arrows, footer, icons, code blocks). No prose, no code fences.",
        },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Label plan failed [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text: string = j?.choices?.[0]?.message?.content ?? "";
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const m = cleaned.match(/\[[\s\S]*\]/);
  let arr: unknown = [];
  try {
    arr = JSON.parse(m ? m[0] : cleaned);
  } catch {
    arr = [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => String(s).toLowerCase().trim())
    .filter((s) => s.length > 0 && s.length < 40)
    .slice(0, 12);
}

async function generateImage(prompt: string, labels: string[]): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");

  const styled = `A 16:9 Excalidraw-style whiteboard EDUCATIONAL INFOGRAPHIC.

Topic: ${prompt}

${STYLE_BASE}

The infographic MUST clearly include these distinct visual elements (each one placed with generous whitespace between it and every other element, non-overlapping, easy to segment later):
${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}

Layout rules:
- Top: a title pill/banner.
- Middle: the main content elements arranged in a clean grid or row (2-4 columns) with clear gaps.
- Bottom: a small footer or mascot pill if it fits the topic.
- Every element must be visually separated (>=40px gap). No overlapping outlines.
- Handwritten marker-style short labels next to each element.

Absolutely no photorealism, no watercolor, no 3D, no dark backgrounds.`;

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: styled,
      size: "1536x1024",
      n: 1,
      quality: "high",
      background: "auto",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI image failed: ${res.status} ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI image returned no data`);
  return `data:image/png;base64,${b64}`;
}

export const generateStyledImageWithLabels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    const lovable = process.env.LOVABLE_API_KEY;
    if (!lovable) throw new Error("LOVABLE_API_KEY missing");

    const labels = await planLabels(data.prompt, lovable);
    if (labels.length === 0) throw new Error("Planner returned no labels");

    const imageDataUrl = await generateImage(data.prompt, labels);
    return { imageDataUrl, labels };
  });
