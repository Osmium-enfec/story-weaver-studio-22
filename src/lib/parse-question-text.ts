import type { PredictSelectMode, QuestionKind } from "@/lib/compose-scene";

export interface ParsedQuestion {
  kind: QuestionKind;
  question: string;
  options: [string, string, string, string];
  predictCode?: string;
  predictSelectMode?: PredictSelectMode;
}

const OPTION_LINE =
  /^\s*([A-Da-d])[\s).:\-–—]*\s*(.+?)\s*$/;

const FENCE_RE = /```(?:[\w+-]*)\s*\n?([\s\S]*?)```/;

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
  return fallback === "predictOutput" ? "predictOutput" : fallback;
}

function detectSelectMode(text: string, fallback: PredictSelectMode): PredictSelectMode {
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
  if (kindHint === "predictOutput") {
    return parsePredictOutputText(raw, "mcq");
  }

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

/** Parse predict-output paste: question + fenced/unfenced code + A–D options. */
export function parsePredictOutputText(
  raw: string,
  selectModeHint: PredictSelectMode = "mcq",
): ParsedQuestion | null {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length < 10) return null;

  let predictCode = "";
  let remainder = text;
  const fence = text.match(FENCE_RE);
  if (fence) {
    predictCode = fence[1].replace(/\n$/, "");
    remainder = (text.slice(0, fence.index) + text.slice((fence.index ?? 0) + fence[0].length))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const lines = remainder
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  const options: string[] = [];
  let firstOptionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(OPTION_LINE);
    if (m) {
      if (firstOptionIdx < 0) firstOptionIdx = i;
      const letter = m[1].toUpperCase();
      const idx = letter.charCodeAt(0) - 65;
      if (idx >= 0 && idx < 4) options[idx] = m[2].trim();
    }
  }
  if (firstOptionIdx < 0 || !options[0] || !options[1] || !options[2] || !options[3]) {
    return null;
  }

  const beforeOptions = lines.slice(0, firstOptionIdx);
  if (!predictCode.trim()) {
    // No fence: treat indented / CODE: block lines before options as code when possible.
    const codeStart = beforeOptions.findIndex(
      (l) =>
        /^code\s*:/i.test(l.trim()) ||
        /^(def |class |print\(|for |while |if |import |from |x\s*=)/.test(l.trim()),
    );
    if (codeStart >= 0) {
      const header = beforeOptions[codeStart].replace(/^code\s*:/i, "").trim();
      const codeLines = [
        ...(header ? [header] : []),
        ...beforeOptions.slice(codeStart + 1),
      ];
      predictCode = codeLines.join("\n").trim();
      beforeOptions.splice(codeStart);
    }
  }

  const question = beforeOptions.map((l) => l.trim()).filter(Boolean).join(" ").trim();
  if (question.length < 3 || !predictCode.trim()) return null;

  return {
    kind: "predictOutput",
    question,
    options: [options[0], options[1], options[2], options[3]],
    predictCode: predictCode.trim(),
    predictSelectMode: detectSelectMode(raw, selectModeHint),
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
  const kind =
    input.kind === "msq" ||
    input.kind === "mcq" ||
    input.kind === "predictOutput"
      ? input.kind
      : kindHint;
  return {
    kind,
    question,
    options,
    predictCode: input.predictCode?.trim() || undefined,
    predictSelectMode:
      input.predictSelectMode === "msq" || input.predictSelectMode === "mcq"
        ? input.predictSelectMode
        : undefined,
  };
}
