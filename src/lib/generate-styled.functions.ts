import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";
import {
  buildCompositeImagePrompt,
  COMPOSITE_IMAGE_SIZE,
  COURSE_VISUAL_STYLE,
} from "@/lib/course-visual-style";

const Input = z.object({
  prompt: z.string().min(3).max(2000),
});

async function planLabels(userPrompt: string): Promise<string[]> {
  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: openAIHeaders(),
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            `You plan Excalidraw-style educational infographics for a Python-for-AI course. ${COURSE_VISUAL_STYLE.replace(/\n/g, " ")} Output ONLY a JSON array of 3-10 short lowercase noun phrases (1-3 words) naming distinct visual elements. No prose, no code fences.`,
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

  const styled = `${buildCompositeImagePrompt(prompt, undefined)}

Include these visual ideas naturally in the composition:
${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: styled,
      size: COMPOSITE_IMAGE_SIZE,
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
  .middleware([requireAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    requireOpenAIKey();

    const labels = await planLabels(data.prompt);
    if (labels.length === 0) throw new Error("Planner returned no labels");

    const imageDataUrl = await generateImage(data.prompt, labels);
    return { imageDataUrl, labels };
  });
