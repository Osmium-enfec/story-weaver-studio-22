import type { QuestionKind } from "@/lib/compose-scene";

export interface ParsedQuestion {
  kind: QuestionKind;
  question: string;
  options: [string, string, string, string];
}

const OPTION_LINE =
  /^\s*([A-Da-d])[\s).:\-–—]*\s*(.+?)\s*$/;

function detectKind(text: string, fallback: QuestionKind): QuestionKind {
  const lower = text.toLowerCase();
  if (
    /\b(select all|choose all|pick all|multiple select|all that apply|more than one)\b/.test(
      lower,
    )
  ) {
    return "msq";
  }
  if (/\b(select one|pick one|single answer|only one)\b/.test(lower)) {
    return "mcq";
  }
  return fallback;
}

/** Regex parser — no API key required. */
export function parseQuestionTextFallback(
  raw: string,
  kindHint: QuestionKind = "mcq",
): ParsedQuestion | null {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 5) return null;

  const options: string[] = [];
  let firstOptionIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPTION_LINE);
    if (m) {
      if (firstOptionIdx < 0) firstOptionIdx = i;
      const letter = m[1].toUpperCase();
      const idx = letter.charCodeAt(0) - 65;
      if (idx >= 0 && idx < 4) {
        options[idx] = m[2].trim();
      }
    }
  }

  if (firstOptionIdx < 0) return null;
  if (!options[0] || !options[1] || !options[2] || !options[3]) return null;

  const question = lines.slice(0, firstOptionIdx).join(" ").trim();
  if (question.length < 3) return null;

  return {
    kind: detectKind(raw, kindHint),
    question,
    options: [options[0], options[1], options[2], options[3]],
  };
}

export function normalizeParsedQuestion(
  input: Partial<ParsedQuestion> & { options?: string[] },
  kindHint: QuestionKind,
): ParsedQuestion | null {
  const question = input.question?.trim() ?? "";
  const opts = input.options ?? [];
  if (question.length < 3 || opts.length < 4) return null;
  const options = opts.slice(0, 4).map((o) => String(o).trim()) as [
    string,
    string,
    string,
    string,
  ];
  if (options.some((o) => !o)) return null;
  const kind = input.kind === "msq" || input.kind === "mcq" ? input.kind : kindHint;
  return { kind, question, options };
}
