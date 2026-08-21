/** Keyboard typing loop for code scenes (typing variant). */
export const CODE_TYPING_SFX = "/sfx/typing-keyboard.mp3";

/** Default characters typed per second for silent / timed code typing. */
export const DEFAULT_CODE_TYPING_CPS = 28;

/** Pause after typing finishes before the Run button is pressed (ms). */
export const DEFAULT_CODE_RUN_DELAY_MS = 700;
/** How long the pressed-state flash lasts (ms). */
export const CODE_RUN_PRESS_MS = 180;
/** Hold time for output after Run (used when suggesting scene duration). */
export const DEFAULT_CODE_OUTPUT_HOLD_MS = 2500;

export interface TypingProgressOpts {
  /** Characters per second (when set with durationMs, overrides the legacy curve). */
  cps?: number;
  /** Full scene duration in ms. */
  durationMs?: number;
}

/** One type → run → output cycle. Later beats append more code. */
export interface CodeTypingBeat {
  id: string;
  /** Code typed in this step (appended after previous steps). */
  code: string;
  /** Console output shown after Run for this step. */
  output: string;
  /** How long to show this output (ms). */
  outputHoldMs: number;
  /** Delay after this step's typing before Run (ms). */
  runDelayMs: number;
}

export interface CodeBeatSegment {
  index: number;
  prefix: string;
  delta: string;
  cumulative: string;
  output: string;
  typeStartMs: number;
  typeEndMs: number;
  runAtMs: number;
  outputStartMs: number;
  outputEndMs: number;
}

export interface CodeBeatTimeline {
  segments: CodeBeatSegment[];
  totalMs: number;
  fullCode: string;
}

export type CodeRunPhase = "idle" | "ready" | "pressing" | "done";

export interface CodeBeatFrame {
  visibleCode: string;
  showCaret: boolean;
  runPhase: CodeRunPhase;
  /** Active output text, or null when the panel is hidden. */
  output: string | null;
  typingActive: boolean;
  beatIndex: number;
}

export function newCodeTypingBeatId(): string {
  return `beat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function emptyCodeTypingBeat(
  partial?: Partial<Omit<CodeTypingBeat, "id">> & { id?: string },
): CodeTypingBeat {
  return {
    id: partial?.id ?? newCodeTypingBeatId(),
    code: partial?.code ?? "",
    output: partial?.output ?? "",
    outputHoldMs: partial?.outputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS,
    runDelayMs: partial?.runDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS,
  };
}

/** How long typing takes at the given CPS (ms). */
export function typingDurationFromCps(code: string, cps: number): number {
  const rate = Math.max(1, cps);
  if (!code.length) return 0;
  return Math.ceil((code.length / rate) * 1000);
}

/**
 * Visible character count for typing animation.
 * With cps + durationMs: types at constant CPS and holds once finished.
 * Otherwise: legacy curve (finishes slightly before progress=1).
 */
export function typingVisibleChars(
  code: string,
  progress: number,
  opts?: TypingProgressOpts,
): number {
  const total = code.length;
  if (total <= 0) return 0;
  const p = Math.min(1, Math.max(0, progress));
  const cps = opts?.cps;
  const durationMs = opts?.durationMs;
  if (cps != null && cps > 0 && durationMs != null && durationMs > 0) {
    const elapsedMs = p * durationMs;
    return Math.min(total, Math.floor((elapsedMs / 1000) * cps));
  }
  return Math.floor(total * Math.min(1, p * 1.15));
}

export function isTypingInProgress(
  code: string,
  progress: number,
  opts?: TypingProgressOpts,
): boolean {
  return (
    code.length > 0 &&
    typingVisibleChars(code, progress, opts) < code.length &&
    progress < 1
  );
}

/** Progress (0..1) along the scene where typing animation and SFX end. */
export function typingSpeechEndProgress(
  code: string,
  opts?: TypingProgressOpts,
): number {
  if (!code.length) return 0;
  const cps = opts?.cps;
  const durationMs = opts?.durationMs;
  if (cps != null && cps > 0 && durationMs != null && durationMs > 0) {
    return Math.min(1, typingDurationFromCps(code, cps) / Math.max(1, durationMs));
  }
  if (!isTypingInProgress(code, 0, opts)) return 0;
  let lo = 0;
  let hi = 1;
  while (hi - lo > 0.0005) {
    const mid = (lo + hi) / 2;
    if (isTypingInProgress(code, mid, opts)) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function beatsToFullCode(beats: CodeTypingBeat[]): string {
  let out = "";
  for (const beat of beats) {
    out = appendBeatCode(out, beat.code ?? "");
  }
  return out;
}

/**
 * Append the next step's code so it always continues on a new line
 * (unless the previous already ended with a newline or the next already starts with one).
 */
export function appendBeatCode(prefix: string, delta: string): string {
  if (!delta) return prefix;
  if (!prefix) return delta;
  if (prefix.endsWith("\n") || delta.startsWith("\n")) return prefix + delta;
  return `${prefix}\n${delta}`;
}

/** Effective delta typed for a step after `prefix` (may inject a leading newline). */
export function beatDeltaForPrefix(prefix: string, delta: string): string {
  if (!delta) return "";
  if (!prefix) return delta;
  if (prefix.endsWith("\n") || delta.startsWith("\n")) return delta;
  return `\n${delta}`;
}

export function normalizeCodeTypingBeats(
  beats: CodeTypingBeat[] | null | undefined,
): CodeTypingBeat[] {
  if (!beats?.length) return [];
  return beats.map((b) =>
    emptyCodeTypingBeat({
      id: b.id,
      code: b.code ?? "",
      output: b.output ?? "",
      outputHoldMs: Math.max(200, Math.round(b.outputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS)),
      runDelayMs: Math.max(0, Math.round(b.runDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS)),
    }),
  );
}

/**
 * Build beats from legacy flat fields or an existing beat list.
 * Prefers `beats` when present and non-empty.
 */
export function resolveCodeTypingBeats(input: {
  beats?: CodeTypingBeat[] | null;
  code?: string;
  output?: string;
  runDelayMs?: number;
  outputHoldMs?: number;
}): CodeTypingBeat[] {
  const fromBeats = normalizeCodeTypingBeats(input.beats);
  if (fromBeats.length > 0) return fromBeats;
  const code = input.code ?? "";
  if (!code.trim() && !(input.output ?? "").trim()) return [];
  return [
    emptyCodeTypingBeat({
      code,
      output: input.output ?? "",
      runDelayMs: input.runDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS,
      outputHoldMs: input.outputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS,
    }),
  ];
}

export function buildCodeBeatTimeline(
  beats: CodeTypingBeat[],
  cps: number,
): CodeBeatTimeline {
  const rate = Math.max(1, cps);
  const segments: CodeBeatSegment[] = [];
  let cursor = 0;
  let prefix = "";

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i]!;
    const rawDelta = beat.code ?? "";
    const delta = beatDeltaForPrefix(prefix, rawDelta);
    const typeStartMs = cursor;
    const typeDur = typingDurationFromCps(delta, rate);
    const typeEndMs = typeStartMs + typeDur;
    const runDelay = Math.max(0, beat.runDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS);
    const runAtMs = typeEndMs + runDelay;
    const outputStartMs = runAtMs;
    const hold = Math.max(200, beat.outputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS);
    const outputEndMs = outputStartMs + CODE_RUN_PRESS_MS + hold;
    const cumulative = appendBeatCode(prefix, rawDelta);
    segments.push({
      index: i,
      prefix,
      delta,
      cumulative,
      output: beat.output ?? "",
      typeStartMs,
      typeEndMs,
      runAtMs,
      outputStartMs,
      outputEndMs,
    });
    prefix = cumulative;
    cursor = outputEndMs;
  }

  return {
    segments,
    totalMs: Math.max(0, cursor),
    fullCode: prefix,
  };
}

export function suggestedBeatsDurationMs(beats: CodeTypingBeat[], cps: number): number {
  return buildCodeBeatTimeline(beats, cps).totalMs;
}

/** @deprecated Prefer suggestedBeatsDurationMs */
export function suggestedCodeTypingDurationMs(
  code: string,
  cps: number,
  runDelayMs = DEFAULT_CODE_RUN_DELAY_MS,
  outputHoldMs = DEFAULT_CODE_OUTPUT_HOLD_MS,
): number {
  return suggestedBeatsDurationMs(
    [
      emptyCodeTypingBeat({
        code,
        output: " ",
        runDelayMs,
        outputHoldMs,
      }),
    ],
    cps,
  );
}

export function resolveCodeBeatFrame(
  elapsedMs: number,
  timeline: CodeBeatTimeline,
  cps: number,
): CodeBeatFrame {
  const t = Math.max(0, elapsedMs);
  const segs = timeline.segments;
  if (!segs.length) {
    return {
      visibleCode: "",
      showCaret: false,
      runPhase: "idle",
      output: null,
      typingActive: false,
      beatIndex: 0,
    };
  }

  const last = segs[segs.length - 1]!;
  if (t >= last.outputEndMs) {
    return {
      visibleCode: last.cumulative,
      showCaret: false,
      runPhase: "done",
      output: last.output.trim() ? last.output : null,
      typingActive: false,
      beatIndex: last.index,
    };
  }

  for (const seg of segs) {
    if (t < seg.typeStartMs) continue;
    if (t < seg.typeEndMs) {
      const localMs = t - seg.typeStartMs;
      const typed = Math.min(
        seg.delta.length,
        Math.floor((localMs / 1000) * Math.max(1, cps)),
      );
      return {
        visibleCode: seg.prefix + seg.delta.slice(0, typed),
        showCaret: typed < seg.delta.length,
        runPhase: "idle",
        output: null,
        typingActive: seg.delta.length > 0 && typed < seg.delta.length,
        beatIndex: seg.index,
      };
    }
    if (t < seg.runAtMs) {
      return {
        visibleCode: seg.cumulative,
        showCaret: false,
        runPhase: "ready",
        output: null,
        typingActive: false,
        beatIndex: seg.index,
      };
    }
    if (t < seg.runAtMs + CODE_RUN_PRESS_MS) {
      return {
        visibleCode: seg.cumulative,
        showCaret: false,
        runPhase: "pressing",
        output: seg.output.trim() ? seg.output : null,
        typingActive: false,
        beatIndex: seg.index,
      };
    }
    if (t < seg.outputEndMs) {
      return {
        visibleCode: seg.cumulative,
        showCaret: false,
        runPhase: "done",
        output: seg.output.trim() ? seg.output : null,
        typingActive: false,
        beatIndex: seg.index,
      };
    }
  }

  return {
    visibleCode: last.cumulative,
    showCaret: false,
    runPhase: "done",
    output: last.output.trim() ? last.output : null,
    typingActive: false,
    beatIndex: last.index,
  };
}

/** Absolute typing ranges within a scene (for SFX mix). */
export function codeTypingSfxRangesMs(
  beats: CodeTypingBeat[],
  cps: number,
): { startMs: number; endMs: number }[] {
  const timeline = buildCodeBeatTimeline(beats, cps);
  return timeline.segments
    .filter((s) => s.typeEndMs > s.typeStartMs)
    .map((s) => ({ startMs: s.typeStartMs, endMs: s.typeEndMs }));
}

/* ---------- Legacy single-beat helpers (kept for simple callers) ---------- */

export interface CodeRunTimingOpts {
  code: string;
  cps?: number;
  durationMs: number;
  runDelayMs?: number;
  outputHoldMs?: number;
}

export function codeTypingEndMs(opts: Pick<CodeRunTimingOpts, "code" | "cps" | "durationMs">): number {
  const cps = opts.cps ?? DEFAULT_CODE_TYPING_CPS;
  if (opts.cps != null && opts.cps > 0 && opts.durationMs > 0) {
    return Math.min(opts.durationMs, typingDurationFromCps(opts.code, cps));
  }
  return (
    typingSpeechEndProgress(opts.code, {
      cps: opts.cps,
      durationMs: opts.durationMs,
    }) * opts.durationMs
  );
}

export function codeRunAtMs(opts: CodeRunTimingOpts): number {
  const delay = Math.max(0, opts.runDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS);
  return Math.min(opts.durationMs, codeTypingEndMs(opts) + delay);
}

export function codeRunPhase(
  progress: number,
  opts: CodeRunTimingOpts,
): CodeRunPhase {
  if (!opts.durationMs || opts.durationMs <= 0) return "idle";
  const elapsed = Math.min(1, Math.max(0, progress)) * opts.durationMs;
  const typingEnd = codeTypingEndMs(opts);
  const runAt = codeRunAtMs(opts);
  if (elapsed < typingEnd) return "idle";
  if (elapsed < runAt) return "ready";
  if (elapsed < runAt + CODE_RUN_PRESS_MS) return "pressing";
  return "done";
}

export function codeOutputVisible(progress: number, opts: CodeRunTimingOpts): boolean {
  const phase = codeRunPhase(progress, opts);
  return phase === "pressing" || phase === "done";
}
