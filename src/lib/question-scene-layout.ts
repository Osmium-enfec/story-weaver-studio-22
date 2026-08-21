import type { QuestionKind } from "@/lib/compose-scene";
export const QUESTION_MARK_GAP_MS = 2000;

/** Default countdown duration on the mark screen. */
export const QUESTION_MARK_COUNTDOWN_SEC_DEFAULT = 3;

/** Pause after countdown before sliding to the next scene. */
export const QUESTION_POST_COUNTDOWN_GAP_MS = 2000;

export const QUESTION_MARK_SCREEN_TEXT_DEFAULT = "Mark your answers";

export const QUESTION_INTRO_SCREEN_TEXT_DEFAULT = "Now test your understanding";

/** Accent matching the looping orange video background. */
export const QUESTION_OPTION_ACCENT = "#f67e00";

/** Left→right orange gradient from the video loop bg. */
export const QUESTION_BG_GRADIENT_STOPS = ["#ffb404", "#f67e00", "#e13900"] as const;

export const QUESTION_BG_GRADIENT_CSS =
  "linear-gradient(90deg, #ffb404 0%, #f67e00 50%, #e13900 100%)";

/** Coding-problem intro / countdown defaults. */
export const CODING_INTRO_SCREEN_TEXT_DEFAULT =
  "Now let's try to solve a coding problem";
/** Shown on screen + spoken (includes the countdown words). */
export const CODING_MARK_SCREEN_TEXT_DEFAULT =
  "Coding screen coming up in 3, 2, 1";

/** Pause after intro voiceover before the question card appears. */
export const QUESTION_INTRO_GAP_MS = 2000;

export interface CodingTestCase {
  label: string;
  input: string;
  output: string;
}

export function emptyCodingTestCases(): [
  CodingTestCase,
  CodingTestCase,
  CodingTestCase,
] {
  return [
    { label: "Case 1", input: "", output: "" },
    { label: "Case 2", input: "", output: "" },
    { label: "Case 3", input: "", output: "" },
  ];
}

/** @deprecated Use questionMarkTotalHoldMs */
export const QUESTION_MARK_HOLD_MS =
  QUESTION_MARK_GAP_MS + QUESTION_MARK_COUNTDOWN_SEC_DEFAULT * 1000;

export const QUESTION_REVEAL_STEPS = [
  "question",
  "hint",
  "option-a",
  "option-b",
  "option-c",
  "option-d",
] as const;

/** Reveal order for predict-output: question → code → hint → options. */
export const PREDICT_OUTPUT_REVEAL_STEPS = [
  "question",
  "code",
  "hint",
  "option-a",
  "option-b",
  "option-c",
  "option-d",
] as const;

/** Reveal order for coding-problem layout: left panel → editor → tests. */
export const CODING_REVEAL_STEPS = ["problem", "code", "tests"] as const;

export type QuestionRevealStep = (typeof QUESTION_REVEAL_STEPS)[number];
export type PredictOutputRevealStep = (typeof PREDICT_OUTPUT_REVEAL_STEPS)[number];
export type CodingRevealStep = (typeof CODING_REVEAL_STEPS)[number];
export type QuestionDisplayPhase =
  | "intro"
  | "intro-gap"
  | "question"
  | "mark-gap"
  | "mark";

export interface QuestionSceneContent {
  kind: QuestionKind;
  question: string;
  subtitle: string;
  options: [string, string, string, string];
  correct: ("A" | "B" | "C" | "D")[];
  codingTitle?: string;
  codingStarterCode?: string;
  codingTestCases?: CodingTestCase[];
  /** Predict-output code block. */
  predictCode?: string;
  /** Predict-output option style (mcq / msq). */
  predictSelectMode?: "mcq" | "msq";
}

/** Effective MCQ vs MSQ chrome for option markers. */
export function questionOptionMode(
  content: Pick<QuestionSceneContent, "kind" | "predictSelectMode">,
): "mcq" | "msq" {
  if (content.kind === "msq") return "msq";
  if (content.kind === "predictOutput") {
    return content.predictSelectMode === "msq" ? "msq" : "mcq";
  }
  return "mcq";
}

export function questionRevealStepsFor(
  kind: QuestionKind,
): readonly string[] {
  return kind === "predictOutput" ? PREDICT_OUTPUT_REVEAL_STEPS : QUESTION_REVEAL_STEPS;
}

export interface QuestionMarkSettings {
  text: string;
  gapMs: number;
  countdownMs: number;
  audioUrl?: string;
}

export interface QuestionIntroSettings {
  text: string;
  gapMs: number;
  durationMs: number;
  audioUrl?: string;
}

export const QUESTION_KIND_LABELS: Record<string, string> = {
  mcq: "Multiple Choice",
  msq: "Multiple Select",
  coding: "Coding Problem",
  predictOutput: "Predict Output",
};

export const QUESTION_HINT_LABELS: Record<string, string> = {
  mcq: "Select one answer.",
  msq: "Select all that apply.",
  coding: "Write a solution in the editor.",
  predictOutput: "What does this code output?",
};

export function questionMarkSettingsFromScene(scene: {
  kind?: string;
  questionKind?: string;
  questionMarkText?: string;
  questionMarkGapMs?: number;
  questionMarkCountdownSec?: number;
  questionMarkAudioUrl?: string;
  holdMs?: number;
}): QuestionMarkSettings {
  const countdownSec =
    scene.questionMarkCountdownSec ?? QUESTION_MARK_COUNTDOWN_SEC_DEFAULT;
  const gapMs = scene.questionMarkGapMs ?? QUESTION_MARK_GAP_MS;
  const countdownMs = countdownSec * 1000;
  const fallbackText =
    scene.questionKind === "coding"
      ? CODING_MARK_SCREEN_TEXT_DEFAULT
      : QUESTION_MARK_SCREEN_TEXT_DEFAULT;
  return {
    text: scene.questionMarkText?.trim() || fallbackText,
    gapMs,
    countdownMs,
    audioUrl: scene.questionMarkAudioUrl,
  };
}

export function questionMarkGapMs(scene: { kind?: string; questionMarkGapMs?: number }): number {
  if (scene.kind !== "question") return 0;
  return scene.questionMarkGapMs ?? QUESTION_MARK_GAP_MS;
}

export function questionMarkCountdownMs(scene: {
  kind?: string;
  questionMarkCountdownSec?: number;
}): number {
  if (scene.kind !== "question") return 0;
  const sec = scene.questionMarkCountdownSec ?? QUESTION_MARK_COUNTDOWN_SEC_DEFAULT;
  return sec * 1000;
}

/** Mark phases only: pre-countdown gap + countdown timer. */
export function questionMarkTotalHoldMs(scene: {
  kind?: string;
  questionMarkGapMs?: number;
  questionMarkCountdownSec?: number;
}): number {
  if (scene.kind !== "question") return 0;
  return questionMarkGapMs(scene) + questionMarkCountdownMs(scene);
}

/** Full post-speech tail before scene transition: gap → countdown → pause → slide. */
export function questionPostSpeechVisualMs(scene: {
  kind?: string;
  questionMarkGapMs?: number;
  questionMarkCountdownSec?: number;
  questionMarkDurationMs?: number;
}): number {
  if (scene.kind !== "question") return 0;
  const gapMs = questionMarkGapMs(scene);
  const countdownMs = questionMarkCountdownMs(scene);
  const visualTail = countdownMs + QUESTION_POST_COUNTDOWN_GAP_MS;
  // Keep the mark screen up at least as long as the spoken countdown VO.
  const audioTail =
    scene.questionMarkDurationMs != null && scene.questionMarkDurationMs > 0
      ? scene.questionMarkDurationMs + 250
      : visualTail;
  return gapMs + Math.max(visualTail, audioTail);
}

/** @deprecated Alias */
export function questionMarkHoldMs(scene: Parameters<typeof questionMarkTotalHoldMs>[0]): number {
  return questionMarkTotalHoldMs(scene);
}

export function questionPostSpeechAt(
  elapsedAfterSpeechMs: number,
  scene: Parameters<typeof questionMarkSettingsFromScene>[0] & {
    questionMarkDurationMs?: number;
  },
): { phase: "gap" | "countdown" | "post-hold" | "done"; markElapsedMs: number } {
  const { gapMs, countdownMs } = questionMarkSettingsFromScene(scene);
  const visualTail = countdownMs + QUESTION_POST_COUNTDOWN_GAP_MS;
  const audioTail =
    scene.questionMarkDurationMs != null && scene.questionMarkDurationMs > 0
      ? scene.questionMarkDurationMs + 250
      : visualTail;
  const afterGapMs = Math.max(visualTail, audioTail);
  const tailMs = gapMs + afterGapMs;
  if (elapsedAfterSpeechMs >= tailMs) {
    return { phase: "done", markElapsedMs: countdownMs };
  }
  if (elapsedAfterSpeechMs < gapMs) {
    return { phase: "gap", markElapsedMs: 0 };
  }
  const markElapsed = elapsedAfterSpeechMs - gapMs;
  if (markElapsed < countdownMs) {
    return { phase: "countdown", markElapsedMs: markElapsed };
  }
  return { phase: "post-hold", markElapsedMs: countdownMs };
}

export function questionIntroSettingsFromScene(scene: {
  kind?: string;
  questionIntroText?: string;
  questionIntroGapMs?: number;
  questionIntroDurationMs?: number;
  questionIntroAudioUrl?: string;
}): QuestionIntroSettings {
  const gapMs = scene.questionIntroGapMs ?? QUESTION_INTRO_GAP_MS;
  const durationMs =
    scene.questionIntroAudioUrl
      ? (scene.questionIntroDurationMs ?? 2500)
      : (scene.questionIntroDurationMs ?? 0);
  return {
    text: scene.questionIntroText?.trim() || QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
    gapMs,
    durationMs,
    audioUrl: scene.questionIntroAudioUrl,
  };
}

export function questionIntroGapMs(scene: {
  kind?: string;
  questionIntroGapMs?: number;
  questionIntroAudioUrl?: string;
}): number {
  if (scene.kind !== "question") return 0;
  if (!scene.questionIntroAudioUrl) return 0;
  return scene.questionIntroGapMs ?? QUESTION_INTRO_GAP_MS;
}

export function questionIntroDurationMs(scene: {
  kind?: string;
  questionIntroDurationMs?: number;
  questionIntroAudioUrl?: string;
}): number {
  if (scene.kind !== "question" || !scene.questionIntroAudioUrl) return 0;
  return scene.questionIntroDurationMs ?? 2500;
}

/** Intro voiceover + gap before question speech begins. */
export function questionPreQuestionMs(scene: {
  kind?: string;
  questionIntroGapMs?: number;
  questionIntroDurationMs?: number;
  questionIntroAudioUrl?: string;
}): number {
  if (scene.kind !== "question" || !scene.questionIntroAudioUrl) return 0;
  return questionIntroDurationMs(scene) + questionIntroGapMs(scene);
}

export function questionIntroAt(
  elapsedMs: number,
  scene: Parameters<typeof questionIntroSettingsFromScene>[0],
): { phase: "intro" | "intro-gap" | "done"; introElapsedMs: number } {
  if (!scene.questionIntroAudioUrl) {
    return { phase: "done", introElapsedMs: 0 };
  }
  const { durationMs, gapMs } = questionIntroSettingsFromScene(scene);
  if (durationMs <= 0) {
    return { phase: "done", introElapsedMs: 0 };
  }
  if (elapsedMs < durationMs) {
    return { phase: "intro", introElapsedMs: elapsedMs };
  }
  if (elapsedMs < durationMs + gapMs) {
    return { phase: "intro-gap", introElapsedMs: durationMs };
  }
  return { phase: "done", introElapsedMs: durationMs + gapMs };
}

/** Map absolute elapsed ms from scene start to display phase + question progress. */
export function questionTimelineAt(
  elapsedMs: number,
  scene: Parameters<typeof questionMarkSettingsFromScene>[0] & {
    questionIntroText?: string;
    questionIntroGapMs?: number;
    questionIntroDurationMs?: number;
    questionIntroAudioUrl?: string;
    durationMs?: number;
  },
  questionSpeechDurMs: number,
): {
  phase: QuestionDisplayPhase;
  questionProgress: number;
  markElapsedMs: number;
} {
  const preMs = questionPreQuestionMs(scene);
  const intro = questionIntroAt(elapsedMs, scene);
  if (intro.phase === "intro") {
    return { phase: "intro", questionProgress: 0, markElapsedMs: 0 };
  }
  if (intro.phase === "intro-gap") {
    return { phase: "intro-gap", questionProgress: 0, markElapsedMs: 0 };
  }

  const afterPre = elapsedMs - preMs;
  if (afterPre < questionSpeechDurMs) {
    const p =
      questionSpeechDurMs <= 1 ? 0 : Math.min(1, Math.max(0, afterPre / questionSpeechDurMs));
    return { phase: "question", questionProgress: p, markElapsedMs: 0 };
  }

  const post = questionPostSpeechAt(afterPre - questionSpeechDurMs, scene);
  if (post.phase === "gap") {
    return { phase: "mark-gap", questionProgress: 1, markElapsedMs: 0 };
  }
  // After question speech: stay on mark screen (countdown → pause → slide).
  return {
    phase: "mark",
    questionProgress: 1,
    markElapsedMs: post.markElapsedMs,
  };
}

export function questionDisplayPhaseAt(
  elapsedAfterSpeechMs: number,
  scene: Parameters<typeof questionMarkSettingsFromScene>[0],
): QuestionDisplayPhase {
  const post = questionPostSpeechAt(elapsedAfterSpeechMs, scene);
  if (post.phase === "gap") return "mark-gap";
  return "mark";
}

export function markCountdownSeconds(elapsedMs: number, countdownMs: number): number {
  if (countdownMs <= 0 || elapsedMs >= countdownMs) return 0;
  return Math.max(1, Math.ceil((countdownMs - elapsedMs) / 1000));
}

export function parseCorrectLetters(
  raw: string,
  kind: QuestionKind,
  predictSelectMode: "mcq" | "msq" = "mcq",
): ("A" | "B" | "C" | "D")[] {
  if (kind === "coding") return [];
  const letters = raw
    .toUpperCase()
    .split(/[^A-D]+/)
    .map((c) => c.trim())
    .filter((c): c is "A" | "B" | "C" | "D" => /^[A-D]$/.test(c));
  const unique = [...new Set(letters)];
  const mode =
    kind === "predictOutput"
      ? predictSelectMode
      : kind === "msq"
        ? "msq"
        : "mcq";
  if (mode === "mcq") return unique.slice(0, 1);
  return unique;
}

export function questionRevealProgress(
  progress: number,
  step: string,
  steps: readonly string[] = QUESTION_REVEAL_STEPS,
): number {
  const idx = steps.indexOf(step);
  if (idx < 0) return 0;
  const n = steps.length;
  const scaled = Math.min(1, progress * 1.05);
  const stepStart = idx / n;
  const stepEnd = (idx + 1) / n;
  if (scaled <= stepStart) return 0;
  if (scaled >= stepEnd) return 1;
  return (scaled - stepStart) / (stepEnd - stepStart);
}

export function codingRevealProgress(progress: number, step: CodingRevealStep): number {
  const idx = CODING_REVEAL_STEPS.indexOf(step);
  if (idx < 0) return 0;
  const n = CODING_REVEAL_STEPS.length;
  const scaled = Math.min(1, progress * 1.05);
  const stepStart = idx / n;
  const stepEnd = (idx + 1) / n;
  if (scaled <= stepStart) return 0;
  if (scaled >= stepEnd) return 1;
  return (scaled - stepStart) / (stepEnd - stepStart);
}

export function sceneToQuestionContent(scene: {
  questionKind?: QuestionKind;
  questionText?: string;
  questionSubtitle?: string;
  questionOptions?: string[];
  questionCorrect?: string[];
  questionCode?: string;
  predictSelectMode?: "mcq" | "msq";
  codingTitle?: string;
  codingStarterCode?: string;
  codingTestCases?: CodingTestCase[];
}): QuestionSceneContent | null {
  const kind = scene.questionKind ?? "mcq";
  if (kind === "coding") {
    if (!scene.questionText?.trim() && !scene.codingTitle?.trim() && !scene.codingStarterCode?.trim()) {
      return null;
    }
    return {
      kind: "coding",
      question: scene.questionText ?? "",
      subtitle: scene.questionSubtitle ?? scene.codingTitle ?? "Coding Problem",
      options: ["", "", "", ""],
      correct: [],
      codingTitle: scene.codingTitle ?? scene.questionSubtitle ?? "Coding Problem",
      codingStarterCode: scene.codingStarterCode ?? "",
      codingTestCases: scene.codingTestCases ?? [],
    };
  }

  const options = scene.questionOptions;
  if (!scene.questionText || !options || options.length < 4) return null;
  if (kind === "predictOutput" && !(scene.questionCode ?? "").trim()) return null;
  return {
    kind,
    question: scene.questionText,
    subtitle:
      scene.questionSubtitle ?? (kind === "predictOutput" ? "Predict output" : "Question"),
    options: [options[0], options[1], options[2], options[3]],
    correct: (scene.questionCorrect ?? [])
      .filter((l): l is "A" | "B" | "C" | "D" => /^[A-D]$/i.test(l))
      .map((l) => l.toUpperCase() as "A" | "B" | "C" | "D"),
    predictCode: kind === "predictOutput" ? scene.questionCode ?? "" : undefined,
    predictSelectMode:
      kind === "predictOutput"
        ? scene.predictSelectMode === "msq"
          ? "msq"
          : "mcq"
        : undefined,
  };
}

export function buildQuestionNarration(content: QuestionSceneContent): string {
  if (content.kind === "coding") {
    const title = content.codingTitle?.trim() || content.subtitle.trim() || "Coding problem";
    const statement = content.question.trim();
    return statement
      ? `${title}. ${statement}`
      : `Let's try to solve this coding problem: ${title}.`;
  }
  const opts = content.options
    .map((text, i) => `${String.fromCharCode(65 + i)}) ${text}`)
    .join(". ");
  if (content.kind === "predictOutput") {
    return `${content.question} Look at this code. ${opts}.`;
  }
  return `${content.question} ${opts}.`;
}

export function isDefaultMarkText(text: string): boolean {
  return text.trim().toLowerCase() === QUESTION_MARK_SCREEN_TEXT_DEFAULT.toLowerCase();
}

export function isDefaultIntroText(text: string): boolean {
  return text.trim().toLowerCase() === QUESTION_INTRO_SCREEN_TEXT_DEFAULT.toLowerCase();
}

export function isDefaultCodingMarkText(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    t === CODING_MARK_SCREEN_TEXT_DEFAULT.toLowerCase() ||
    t === "coding screen coming up in 3, 2, 1" ||
    t === "coding screen coming up in 3, 2,1" ||
    t === "coding screen coming up in"
  );
}

export function isDefaultCodingIntroText(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    t === CODING_INTRO_SCREEN_TEXT_DEFAULT.toLowerCase() ||
    t === "now lets try to solve a coding problem" ||
    t === "now let's try to solve a coding problem"
  );
}
