import type { QuestionKind } from "@/lib/compose-scene";
export const QUESTION_MARK_GAP_MS = 2000;

/** Default countdown duration on the mark screen. */
export const QUESTION_MARK_COUNTDOWN_SEC_DEFAULT = 3;

/** Pause after countdown before sliding to the next scene. */
export const QUESTION_POST_COUNTDOWN_GAP_MS = 2000;

export const QUESTION_MARK_SCREEN_TEXT_DEFAULT = "Mark your answers";

export const QUESTION_INTRO_SCREEN_TEXT_DEFAULT = "Now test your understanding";

/** Pause after intro voiceover before the question card appears. */
export const QUESTION_INTRO_GAP_MS = 2000;

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

export type QuestionRevealStep = (typeof QUESTION_REVEAL_STEPS)[number];
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
};

export const QUESTION_HINT_LABELS: Record<string, string> = {
  mcq: "Select one answer.",
  msq: "Select all that apply.",
};

export function questionMarkSettingsFromScene(scene: {
  kind?: string;
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
  return {
    text: scene.questionMarkText?.trim() || QUESTION_MARK_SCREEN_TEXT_DEFAULT,
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
}): number {
  if (scene.kind !== "question") return 0;
  return (
    questionMarkGapMs(scene) +
    questionMarkCountdownMs(scene) +
    QUESTION_POST_COUNTDOWN_GAP_MS
  );
}

/** @deprecated Alias */
export function questionMarkHoldMs(scene: Parameters<typeof questionMarkTotalHoldMs>[0]): number {
  return questionMarkTotalHoldMs(scene);
}

export function questionPostSpeechAt(
  elapsedAfterSpeechMs: number,
  scene: Parameters<typeof questionMarkSettingsFromScene>[0],
): { phase: "gap" | "countdown" | "post-hold" | "done"; markElapsedMs: number } {
  const { gapMs, countdownMs } = questionMarkSettingsFromScene(scene);
  const tailMs = gapMs + countdownMs + QUESTION_POST_COUNTDOWN_GAP_MS;
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
  const durationMs = scene.questionIntroDurationMs ?? 0;
  return {
    text: scene.questionIntroText?.trim() || QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
    gapMs,
    durationMs,
    audioUrl: scene.questionIntroAudioUrl,
  };
}

export function questionIntroGapMs(scene: { kind?: string; questionIntroGapMs?: number }): number {
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
  const { durationMs, gapMs } = questionIntroSettingsFromScene(scene);
  if (!scene.questionIntroAudioUrl || durationMs <= 0) {
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

export function parseCorrectLetters(raw: string, kind: QuestionKind): ("A" | "B" | "C" | "D")[] {
  const letters = raw
    .toUpperCase()
    .split(/[^A-D]+/)
    .map((c) => c.trim())
    .filter((c): c is "A" | "B" | "C" | "D" => /^[A-D]$/.test(c));
  const unique = [...new Set(letters)];
  if (kind === "mcq") return unique.slice(0, 1);
  return unique;
}

export function questionRevealProgress(progress: number, step: QuestionRevealStep): number {
  const idx = QUESTION_REVEAL_STEPS.indexOf(step);
  if (idx < 0) return 0;
  const n = QUESTION_REVEAL_STEPS.length;
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
}): QuestionSceneContent | null {
  const options = scene.questionOptions;
  if (!scene.questionText || !options || options.length < 4) return null;
  return {
    kind: scene.questionKind ?? "mcq",
    question: scene.questionText,
    subtitle: scene.questionSubtitle ?? "Question",
    options: [options[0], options[1], options[2], options[3]],
    correct: (scene.questionCorrect ?? [])
      .filter((l): l is "A" | "B" | "C" | "D" => /^[A-D]$/i.test(l))
      .map((l) => l.toUpperCase() as "A" | "B" | "C" | "D"),
  };
}

export function buildQuestionNarration(content: QuestionSceneContent): string {
  const opts = content.options
    .map((text, i) => `${String.fromCharCode(65 + i)}) ${text}`)
    .join(". ");
  return `${content.question} ${opts}.`;
}

export function isDefaultMarkText(text: string): boolean {
  return text.trim().toLowerCase() === QUESTION_MARK_SCREEN_TEXT_DEFAULT.toLowerCase();
}

export function isDefaultIntroText(text: string): boolean {
  return text.trim().toLowerCase() === QUESTION_INTRO_SCREEN_TEXT_DEFAULT.toLowerCase();
}
