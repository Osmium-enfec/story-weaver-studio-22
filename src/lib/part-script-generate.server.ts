import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";
import {
  estimatePartScriptDurationMs,
  formatDurationMinutes,
  planFromAiJsonSorted,
  spokenWordCount,
  targetSpokenWords,
  validatePartScriptPlan,
  type PartScriptPlan,
} from "@/lib/part-script";

export interface GeneratePartScriptInput {
  topic: string;
  courseTitle?: string;
  episodeTitle?: string;
  partTitle?: string;
  includeCodingPractice?: boolean;
}

const WORDS = targetSpokenWords();

const SYSTEM_PROMPT = `You write beginner-friendly PART SCRIPTS for a live tutor-led class (screen recording + talking head).
Default course context: “Python for AI”. First project vibe: “Talking with an LLM”.
Connect examples to AI ideas whenever natural: model settings, prompts, chat history, role/content, messages, list of dictionaries, user/assistant/system messages.

Return ONLY JSON:
{
  "scenes": [
    {
      "type": "intro" | "image" | "codeTyping" | "recording2" | "question" | "codingPractice" | "finalCodeTyping",
      "name": "short scene title",
      "script": "spoken narration — see field rules below",
      "scriptAfter": "tutor says AFTER expected output (recording / code / practice scenes)",
      "screen": "SCREEN: what is visible (editor, terminal, browser, slides…)",
      "code": "exact code tutor types or edits (progressive — continue prior scene)",
      "expectedOutput": "EXPECTED OUTPUT after run",
      "imagePrompt": "only for image — detailed diagram brief",
      "placeholderNote": "optional extra recording notes",
      "practiceBrief": "coding task instructions (SCREEN: task)",
      "question": {
        "kind": "mcq",
        "question": "stem only",
        "options": ["A text", "B text", "C text", "D text"],
        "correct": "B"
      }
    }
  ]
}

════════════════════════════════════
SCRIPT STYLE (voice / ElevenLabs)
════════════════════════════════════
- Simple beginner-friendly English. Energetic, friendly, clear.
- Short natural sentences for voice narration.
- Live-class feel: tutor teaches WHILE coding (“watch this…”, “now I’ll change…”).
- Use emotion tags inline: [excited], [thoughtful], [curious], [happy], [serious], [chuckles]
- NEVER use [clear].
- Occasional small jokes, then “[chuckles] Anyway…” and continue teaching.
- Sprinkle emotion tags through EVERY spoken field (script + scriptAfter), not only the intro.

════════════════════════════════════
HARD PATTERN (band order — never go backwards)
════════════════════════════════════
1. Exactly ONE intro — Normal Starting Script (studio / talking head)
2. ZERO OR MORE image (optional concept visuals)
3. ZERO OR MORE codeTyping (optional typed-code beats)
4. ONE OR MORE recording2 — main Screen Recording Flow (tutor typing + speaking). Prefer several progressive scenes.
5. Exactly ONE question — MCQ Section
6. ZERO OR ONE codingPractice — Coding Task Section (include when asked or when the brief is hands-on)
7. Exactly ONE finalCodeTyping — Normal Ending Script (studio / talking head summary). Code optional; SCRIPT REQUIRED.

════════════════════════════════════
SECTION FIELD RULES
════════════════════════════════════

1) intro (Starting Script — Studio)
- script: short energetic intro of what this Part teaches + why it matters for talking with an LLM / Python for AI.
- No code / screen / expectedOutput needed.

2) recording2 / codeTyping (Screen Recording Flow — MAIN)
For EACH scene fill:
- screen: what should be visible
- code: exact code typed or edited
- script: TUTOR SAYS WHILE TYPING / editing
- expectedOutput: output after running (or “no run yet” if mid-edit)
- scriptAfter: TUTOR SAYS AFTER OUTPUT (explain what happened)

CRITICAL progressive rule:
- Do NOT restart fresh code every scene.
- Continue from the previous scene’s code; edit/extend step by step.
- Use phrases like: “Now let’s change this…”, “Instead of this, I’ll write this…”,
  “Now I’ll replace this key…”, “Now I’ll add one more line…”, “Now let’s run it…”

3) question (MCQ)
- Prefer kind "mcq". One question based on this Part.
- question + options A–D + correct letter.
- script: tutor narration BEFORE revealing the answer (set up the check-in).
- scriptAfter: AFTER answer — explain why the correct option is right AND why each wrong option is wrong.
- screen (optional): how the MCQ appears on screen.

4) codingPractice (Coding Task)
- practiceBrief: SCREEN task instructions for the learner.
- script: tutor explains what to do, then TUTOR SAYS WHILE TYPING the solution.
- code: full solution code.
- expectedOutput: expected result.
- scriptAfter: explain the output / celebrate / tie back to AI project ideas.
- screen: optional — editor + task panel description.

5) finalCodeTyping (Ending Script — Studio)
- This is talking-head OUTRO, not a silent code card.
- script: summarize the Part and connect to the next Part.
- code: optional tiny takeaway snippet (one-liner / commented reminder). May be "".

════════════════════════════════════
DURATION (CRITICAL)
════════════════════════════════════
- Spoken words = all script + scriptAfter + question stem + options
- MUST be between ${WORDS.min} and ${WORDS.max} words (target ~${WORDS.target} ≈ 10.5 min @ 135 wpm)
- Expand with real teaching talk-track, check-ins, analogies — not filler

Prefer recording2 scenes for the main teaching arc when the Part is about coding live.
`;

function userPrompt(input: GeneratePartScriptInput): string {
  const bits = [
    `Topic / brief:\n${input.topic.trim()}`,
    input.courseTitle ? `Course: ${input.courseTitle}` : "Course: Python for AI (assume if unsure)",
    input.episodeTitle ? `Episode: ${input.episodeTitle}` : null,
    input.partTitle ? `Part: ${input.partTitle}` : null,
    input.includeCodingPractice
      ? "Include one codingPractice (Coding Task) scene with solution + outputs."
      : "Omit codingPractice unless the brief clearly asks for a hands-on coding task.",
    `Write enough spoken narration for ${WORDS.min}+ words (aim ${WORDS.target}).`,
    "Use emotion tags. Progressive screen-recording edits. Clean scene names.",
  ].filter(Boolean);
  return bits.join("\n\n");
}

async function callOpenAi(
  messages: { role: string; content: string }[],
  opts?: { temperature?: number; maxTokens?: number },
): Promise<unknown> {
  requireOpenAIKey();
  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: openAIHeaders(),
    body: JSON.stringify({
      model: "gpt-4o",
      messages,
      response_format: { type: "json_object" },
      temperature: opts?.temperature ?? 0.65,
      max_tokens: opts?.maxTokens ?? 14000,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${errText.slice(0, 400)}`);
  }
  const j = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = j?.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("AI returned invalid JSON.");
  }
}

function finalize(plan: PartScriptPlan): {
  plan: PartScriptPlan;
  validation: ReturnType<typeof validatePartScriptPlan>;
} {
  const sorted = planFromAiJsonSorted({ scenes: plan.scenes });
  return { plan: sorted, validation: validatePartScriptPlan(sorted) };
}

export async function generatePartScriptPlan(
  input: GeneratePartScriptInput,
): Promise<{ plan: PartScriptPlan; durationMs: number }> {
  const topic = input.topic.trim();
  if (topic.length < 8) {
    throw new Error("Enter a longer topic or brief (at least a sentence).");
  }

  let parsed = await callOpenAi([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(input) },
  ]);
  let { plan, validation } = finalize(planFromAiJsonSorted(parsed));

  if (!validation.ok) {
    const words = spokenWordCount(plan);
    parsed = await callOpenAi(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(input) },
        {
          role: "assistant",
          content: JSON.stringify({ scenes: plan.scenes }),
        },
        {
          role: "user",
          content: [
            "Validation failed. Return a COMPLETE fixed JSON plan.",
            `Errors:\n- ${validation.errors.join("\n- ")}`,
            `Current spoken word count: ${words} (need ${WORDS.min}–${WORDS.max}, target ${WORDS.target}).`,
            `Current duration estimate: ${formatDurationMinutes(validation.durationMs)}.`,
            "Keep band order intro→image→codeTyping→recording2→question→codingPractice→finalCodeTyping.",
            "Ending (finalCodeTyping) MUST have studio talking-head script (summary + next-part tease).",
            "Screen-recording scenes need screen + progressive code + script + expectedOutput + scriptAfter.",
            "Expand narration if under 7 minutes. Keep emotion tags. Do not restart code each scene.",
          ].join("\n"),
        },
      ],
      { temperature: 0.5, maxTokens: 16000 },
    );
    ({ plan, validation } = finalize(planFromAiJsonSorted(parsed)));
  }

  if (
    !validation.ok &&
    validation.errors.every((e) => e.includes("under 7 minutes") || e.includes("over 14 minutes"))
  ) {
    const words = spokenWordCount(plan);
    const needMore = validation.durationMs < 7 * 60 * 1000;
    parsed = await callOpenAi(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            needMore
              ? `Expand spoken narration (script + scriptAfter) to at least ${WORDS.min} words (target ${WORDS.target}).`
              : `Shorten spoken narration to under ${WORDS.max} words.`,
            "Keep the same scene types, names, and structure. Only lengthen/shorten spoken fields.",
            "Keep emotion tags and progressive editing language.",
            "Return full JSON { scenes: [...] }.",
            `Current word count: ${words}.`,
            JSON.stringify({ scenes: plan.scenes }),
          ].join("\n\n"),
        },
      ],
      { temperature: 0.4, maxTokens: 16000 },
    );
    ({ plan, validation } = finalize(planFromAiJsonSorted(parsed)));
  }

  if (!validation.ok) {
    throw new Error(
      `Script still invalid after repair:\n${validation.errors.join("\n")}\n(Estimated ${formatDurationMinutes(validation.durationMs)}, ~${spokenWordCount(plan)} spoken words)`,
    );
  }

  return {
    plan,
    durationMs: estimatePartScriptDurationMs(plan),
  };
}
