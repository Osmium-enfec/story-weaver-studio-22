import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";
import {
  normalizeParsedQuestion,
  parseQuestionTextFallback,
  type ParsedQuestion,
} from "@/lib/parse-question-text";

const Input = z.object({
  text: z.string().min(10).max(8000),
  kind: z.enum(["mcq", "msq"]).optional(),
});

async function parseWithLlm(text: string, kindHint: "mcq" | "msq"): Promise<ParsedQuestion | null> {
  requireOpenAIKey();
  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: openAIHeaders(),
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Extract a multiple-choice quiz from pasted text. Return ONLY JSON:
{ "kind": "mcq" | "msq", "question": "...", "options": ["A text", "B text", "C text", "D text"] }
Rules:
- kind is "msq" if the text says select all / pick many / all that apply; otherwise "mcq".
- question is the stem only (no option letters).
- options must be exactly 4 strings in order A–D, option text only (no "A)" prefix).
- Preserve quotes and code literals in option text exactly.`,
        },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
      max_tokens: 600,
    }),
  });

  if (!res.ok) return null;
  const j = await res.json();
  const raw = j?.choices?.[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(raw);
    return normalizeParsedQuestion(
      {
        kind: parsed.kind,
        question: parsed.question,
        options: Array.isArray(parsed.options) ? parsed.options.map(String) : [],
      },
      kindHint,
    );
  } catch {
    return null;
  }
}

export const parseQuestionTextFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    const kindHint = data.kind ?? "mcq";
    const llm = await parseWithLlm(data.text, kindHint);
    if (llm) return llm;

    const fallback = parseQuestionTextFallback(data.text, kindHint);
    if (fallback) return fallback;

    throw new Error(
      "Could not parse that question. Paste the stem plus options A–D (e.g. A) True).",
    );
  });
