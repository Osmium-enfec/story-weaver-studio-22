import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";
import type { BoxRole } from "@/lib/build-reveal";
import type { BoxSpeechBinding } from "@/lib/box-speech-binding";

const BindInput = z.object({
  narrationText: z.string().min(1),
  sceneTitle: z.string().optional(),
  boxes: z.array(
    z.object({
      id: z.string(),
      role: z.enum(["title", "subtitle", "footer", "content", "hub"]).optional(),
      label: z.string().optional(),
      matchTerms: z.array(z.string()).optional(),
    }),
  ),
});

function fallbackBindings(
  boxes: Array<{ id: string; role?: BoxRole; label?: string }>,
  narration: string,
): BoxSpeechBinding[] {
  const clauses = narration
    .split(/(?<=[.!?])\s+|\.\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const contentClauses = clauses.filter(
    (c) => !/foundation|clean ai code|data types in ai/i.test(c) || c.length > 40,
  );

  let clauseIdx = 0;
  return boxes.map((b, i) => {
    const role = b.role ?? "content";
    const label = b.label?.trim() || `box ${i + 1}`;
    let phrase: string;
    if (role === "title") {
      phrase = clauses[0]?.slice(0, 120) ?? label;
    } else if (role === "footer") {
      phrase = clauses[clauses.length - 1] ?? narration.slice(-120);
    } else if (role === "hub" || role === "subtitle") {
      phrase = clauses[1] ?? clauses[0] ?? label;
    } else {
      phrase = contentClauses[clauseIdx] ?? clauses[Math.min(clauseIdx + 1, clauses.length - 1)] ?? label;
      clauseIdx++;
    }
    const spoken = phrase.replace(/\s+/g, " ").trim();
    const terms: string[] = [];
    if (!/^box \d+$/i.test(label)) terms.push(label);
    if (role === "content") {
      if (/string/i.test(label) || /string/i.test(spoken)) terms.push("strings", "string");
      if (/integer/i.test(label) || /integer/i.test(spoken)) terms.push("integers", "integer");
      if (/float/i.test(label) || /float/i.test(spoken)) terms.push("floats", "float");
      if (/boolean/i.test(label) || /boolean/i.test(spoken)) terms.push("boolean", "booleans");
    }
    return {
      boxId: b.id,
      role,
      displayLabel: label,
      spokenPhrases: [spoken].filter(Boolean),
      searchTerms: [...new Set(terms)],
    };
  });
}

/** GPT: bind each box to phrases from the narration script (not image text alone). */
export const bindBoxesToNarration = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => BindInput.parse(d))
  .handler(async ({ data }): Promise<{ bindings: BoxSpeechBinding[] }> => {
    const roles: BoxRole[] = ["title", "subtitle", "footer", "content", "hub"];
    const base = data.boxes.map((b, i) => ({
      boxId: b.id,
      role: (roles.includes(b.role as BoxRole) ? b.role : "content") as BoxRole,
      displayLabel: b.label?.trim() || `box ${i + 1}`,
    }));

    try {
      requireOpenAIKey();
    } catch {
      return { bindings: fallbackBindings(data.boxes, data.narrationText) };
    }

    const boxList = base
      .map((b, i) => {
        const raw = data.boxes[i];
        const terms = raw?.matchTerms?.length ? ` terms=[${raw.matchTerms.join(", ")}]` : "";
        return `${i} id=${b.boxId} role=${b.role} label="${b.displayLabel}"${terms}`;
      })
      .join("\n");

    const sys = `You map infographic reveal boxes to SPOKEN NARRATION phrases.

For each box, return phrases the narrator ACTUALLY SAYS when introducing that visual — copied or closely paraphrased from the narration script (not invented).

Return ONLY JSON:
{
  "bindings": [
    {
      "boxIndex": 0,
      "spokenPhrases": ["exact phrase from narration when this box is discussed", "..."],
      "searchTerms": ["keyword", "synonym", "code fragment like prompt ="]
    }
  ]
}

Rules:
- title/subtitle/footer: use opening/closing narration phrases.
- content/hub: the clause where that concept first appears (order in speech may differ from box index).
- searchTerms: 2-5 STT-friendly tokens (handle plurals, "variables" for Variable, code snippets).
- searchTerms must include how the word is SPOKEN (e.g. label "String" → searchTerms ["strings", "string"]).
- spokenPhrases must come from the narration text below.`;

    try {
      const res = await fetch(`${OPENAI_API}/chat/completions`, {
        method: "POST",
        headers: openAIHeaders(),
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: sys },
            {
              role: "user",
              content: `Scene title: ${data.sceneTitle ?? "(none)"}\n\nNarration:\n${data.narrationText}\n\nBoxes:\n${boxList}`,
            },
          ],
          response_format: { type: "json_object" },
          max_tokens: 1500,
        }),
      });
      if (!res.ok) throw new Error(`bind failed ${res.status}`);
      const j = await res.json();
      const parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
      const arr = Array.isArray(parsed.bindings) ? parsed.bindings : [];

      const bindings = base.map((b, i) => {
        const hit = arr.find((x: { boxIndex?: number }) => Number(x.boxIndex) === i) ?? arr[i];
        const spokenPhrases = Array.isArray(hit?.spokenPhrases)
          ? hit.spokenPhrases.map(String).filter(Boolean)
          : [];
        const searchTerms = Array.isArray(hit?.searchTerms)
          ? hit.searchTerms.map(String).filter(Boolean)
          : [];
        const labelTerms = data.boxes[i]?.matchTerms ?? [];
        const mergedTerms = [...new Set([...labelTerms, ...searchTerms])];
        const fb = fallbackBindings([data.boxes[i]], data.narrationText)[0];
        return {
          ...b,
          spokenPhrases: spokenPhrases.length ? spokenPhrases : fb.spokenPhrases,
          searchTerms: mergedTerms.length
            ? mergedTerms
            : searchTerms.length
              ? searchTerms
              : fb.searchTerms.length
                ? fb.searchTerms
                : [b.displayLabel].filter((l) => !/^box \d+$/i.test(l)),
        };
      });
      return { bindings };
    } catch (e: unknown) {
      console.warn("[box-bind]", e instanceof Error ? e.message : e);
      return { bindings: fallbackBindings(data.boxes, data.narrationText) };
    }
  });
