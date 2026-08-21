import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";
import {
  normalizeParsedQuestion,
  parseQuestionTextFallback,
  type ParsedQuestion,
} from "@/lib/parse-question-text";

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
- options are plain text without leading A) B) etc.`,
        },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = json.choices?.[0]?.message?.content;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ParsedQuestion;
    return normalizeParsedQuestion(parsed, kindHint);
  } catch {
    return null;
  }
}

export async function parseQuestionTextServer(
  text: string,
  kind?: "mcq" | "msq",
): Promise<ParsedQuestion> {
  const kindHint = kind ?? "mcq";
  const llm = await parseWithLlm(text, kindHint);
  if (llm) return llm;

  const fallback = parseQuestionTextFallback(text, kindHint);
  if (fallback) return fallback;

  throw new Error(
    "Could not parse that question. Paste the stem plus options A–D (e.g. A) True).",
  );
}
