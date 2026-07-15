import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";

/**
 * ChatGPT chat restructures narration into short labels before drawing.
 * The Images API pastes long text verbatim unless we do the same prep step.
 */
const BRIEF_SYSTEM = `You turn narration scripts into short labels for an Excalidraw-style educational infographic.

Output ONLY the illustration content below — no JSON, no markdown, no commentary.
Never copy full narration sentences. Use 3–6 words per card description max.

Format (follow exactly):

Title: [2–5 word topic title, e.g. "Project 1: LLM Basics"]
Subtitle: [one short line, 6–12 words]
Cards (4 separate cards in ONE horizontal row):
- STRING (blue): [doodle: speech bubble] · [3–5 words, e.g. Prompts · responses · model names]
- INTEGER (green): [doodle: 123 block] · [3–5 words, e.g. Limits like max tokens]
- FLOAT (yellow/orange): [doodle: thermometer or 0.7] · [3–5 words, e.g. Settings like temperature]
- BOOLEAN (pink): [doodle: check and X] · [3–5 words, e.g. Yes-or-no settings]
Footer: [one short sentence, 6–10 words, e.g. Small topic. Big foundation for clean AI code.]

Adapt card topics to the script when it is not about data types, but keep the same structure: title ribbon, subtitle, 4 separate cards in one row, footer. Use short punchy labels only — never paste "We will use strings for prompts..." style sentences.`;

/** Restructure narration into short infographic labels (like ChatGPT chat does). */
export async function expandScriptToVisualBrief(script: string): Promise<string> {
  requireOpenAIKey();
  const trimmed = script.trim();
  if (!trimmed) return "";

  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: openAIHeaders(),
    body: JSON.stringify({
      model: process.env.OPENAI_BRIEF_MODEL ?? "gpt-4o",
      temperature: 0.4,
      max_tokens: 400,
      messages: [
        { role: "system", content: BRIEF_SYSTEM },
        { role: "user", content: trimmed },
      ],
    }),
  });

  if (!res.ok) {
    console.warn("[compose-brief] planner failed:", res.status, (await res.text()).slice(0, 200));
    return trimmed;
  }

  const json = await res.json();
  const brief = String(json?.choices?.[0]?.message?.content ?? "").trim();
  return brief || trimmed;
}
