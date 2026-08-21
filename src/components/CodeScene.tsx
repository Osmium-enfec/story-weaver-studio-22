import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  buildCodeBeatTimeline,
  DEFAULT_CODE_OUTPUT_HOLD_MS,
  DEFAULT_CODE_RUN_DELAY_MS,
  DEFAULT_CODE_TYPING_CPS,
  resolveCodeBeatFrame,
  resolveCodeTypingBeats,
  typingVisibleChars,
  type CodeTypingBeat,
} from "@/lib/code-scene-sfx";

export type CodeVariant = "typing" | "morph" | "scroll" | "flight";

export interface CodeSceneProps {
  code: string;
  codeTo?: string; // for "morph"
  language?: string; // "ts" | "js" | "py" | "tsx" | ...
  variant: CodeVariant;
  progress: number; // 0..1
  title?: string;
  /** When true, fills the parent card (loop-video compose layout). */
  embedded?: boolean;
  /** Timed typing: characters per second. */
  typingSpeedCps?: number;
  /** Scene duration for CPS-based typing. */
  durationMs?: number;
  /** Console output revealed after Run (user-authored). Legacy single-step. */
  codeOutput?: string;
  /** Delay after typing before Run presses (ms). Legacy. */
  codeRunDelayMs?: number;
  /** How long to show output (ms). Legacy. */
  codeOutputHoldMs?: number;
  /** Multi-step type → run → output cycles. */
  codeTypingBeats?: CodeTypingBeat[];
  /** Monospace font size in px (default 14). */
  fontSizePx?: number;
}

/** ---------- Minimal token highlighter (no deps) ---------- */
const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "class", "extends", "new", "import", "from", "export", "default", "async",
  "await", "try", "catch", "throw", "typeof", "instanceof", "in", "of",
  "true", "false", "null", "undefined", "this", "def", "self", "print",
  "lambda", "None", "True", "False", "elif", "pass", "yield", "with", "as",
  "interface", "type", "enum", "public", "private", "protected", "static",
]);

type Tok = { text: string; kind: "kw" | "str" | "num" | "com" | "fn" | "pun" | "txt" };

function tokenize(line: string): Tok[] {
  const tokens: Tok[] = [];
  // strip comments (// or #)
  const commentIdx = (() => {
    const s = line.search(/(^|[^:])\/\//);
    const h = line.indexOf("#");
    const candidates = [s === -1 ? Infinity : s + (line[s] === "/" ? 0 : 1), h === -1 ? Infinity : h];
    const m = Math.min(...candidates);
    return m === Infinity ? -1 : m;
  })();
  const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  const comment = commentIdx >= 0 ? line.slice(commentIdx) : "";

  const re = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b|[{}()[\];,.:=+\-*/%<>!?&|]+|\s+|.)/g;
  let m: RegExpExecArray | null;
  let prev: Tok | null = null;
  while ((m = re.exec(codePart)) !== null) {
    const t = m[0];
    let kind: Tok["kind"] = "txt";
    if (/^["'`]/.test(t)) kind = "str";
    else if (/^\d/.test(t)) kind = "num";
    else if (/^[A-Za-z_$]/.test(t)) {
      if (KEYWORDS.has(t)) kind = "kw";
      else {
        // function name if next non-space is '('
        const rest = codePart.slice(re.lastIndex);
        if (/^\s*\(/.test(rest)) kind = "fn";
      }
    } else if (/^[{}()[\];,.:=+\-*/%<>!?&|]/.test(t)) kind = "pun";
    else kind = "txt";
    const tok: Tok = { text: t, kind };
    // merge consecutive text/space
    if (prev && prev.kind === kind && (kind === "txt" || kind === "pun")) {
      prev.text += t;
    } else {
      tokens.push(tok);
      prev = tok;
    }
  }
  if (comment) tokens.push({ text: comment, kind: "com" });
  return tokens;
}

function tokenClass(kind: Tok["kind"]): string {
  switch (kind) {
    case "kw": return "text-purple-600";
    case "str": return "text-emerald-600";
    case "num": return "text-amber-600";
    case "com": return "text-slate-400 italic";
    case "fn": return "text-sky-600";
    case "pun": return "text-slate-500";
    default: return "text-slate-800";
  }
}

function Highlighted({ text, fontSizePx = 14 }: { text: string; fontSizePx?: number }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const linePx = Math.round(fontSizePx * 1.75);
  return (
    <>
      {lines.map((line, i) => (
        <div
          key={i}
          className="flex items-center whitespace-pre"
          style={{ minHeight: linePx, lineHeight: `${linePx}px`, fontSize: fontSizePx }}
        >
          <span
            className="mr-4 shrink-0 select-none text-right text-slate-400"
            style={{ width: Math.max(24, fontSizePx * 2) }}
          >
            {i + 1}
          </span>
          <span className="min-w-0">
            {tokenize(line).map((tok, j) => (
              <span key={j} className={tokenClass(tok.kind)}>
                {tok.text}
              </span>
            ))}
          </span>
        </div>
      ))}
    </>
  );
}

/** ---------- Variant renderers ---------- */

function TypingCodeVisible({
  code,
  showCaret,
  endRef,
  fontSizePx = 14,
}: {
  code: string;
  showCaret: boolean;
  endRef?: RefObject<HTMLSpanElement | null>;
  fontSizePx?: number;
}) {
  const lines = code.split("\n");
  const lastIdx = Math.max(0, lines.length - 1);
  const linePx = Math.round(fontSizePx * 1.75);
  return (
    <div className="font-mono" style={{ fontSize: fontSizePx, lineHeight: `${linePx}px` }}>
      {lines.map((line, i) => (
        <div
          key={i}
          className="flex items-center whitespace-pre"
          style={{ minHeight: linePx }}
        >
          <span
            className="mr-4 shrink-0 select-none text-right text-slate-400"
            style={{ width: Math.max(24, fontSizePx * 2) }}
          >
            {i + 1}
          </span>
          <span className="min-w-0">
            {tokenize(line).map((tok, j) => (
              <span key={j} className={tokenClass(tok.kind)}>
                {tok.text}
              </span>
            ))}
            {showCaret && i === lastIdx ? (
              <span className="ml-0.5 inline-block h-[1.05em] w-0.5 animate-pulse bg-slate-700 align-[-0.1em]" />
            ) : null}
          </span>
        </div>
      ))}
      <span ref={endRef} className="block h-px w-px" aria-hidden />
    </div>
  );
}

function TypingCode({
  code,
  progress,
  typingSpeedCps,
  durationMs,
  endRef,
  fontSizePx = 14,
}: {
  code: string;
  progress: number;
  typingSpeedCps?: number;
  durationMs?: number;
  endRef?: RefObject<HTMLSpanElement | null>;
  fontSizePx?: number;
}) {
  const total = code.length;
  const shown = typingVisibleChars(code, progress, {
    cps: typingSpeedCps,
    durationMs,
  });
  return (
    <TypingCodeVisible
      code={code.slice(0, shown)}
      showCaret={shown < total}
      endRef={endRef}
      fontSizePx={fontSizePx}
    />
  );
}

function MorphCode({
  from,
  to,
  progress,
  fontSizePx = 14,
}: {
  from: string;
  to: string;
  progress: number;
  fontSizePx?: number;
}) {
  // cross-fade + subtle slide, aligned line by line
  const fromLines = from.split("\n");
  const toLines = to.split("\n");
  const max = Math.max(fromLines.length, toLines.length);
  const t = Math.min(1, Math.max(0, progress));
  const linePx = Math.round(fontSizePx * 1.75);
  return (
    <div className="font-mono" style={{ fontSize: fontSizePx, lineHeight: `${linePx}px` }}>
      {Array.from({ length: max }).map((_, i) => {
        const f = fromLines[i] ?? "";
        const to_ = toLines[i] ?? "";
        const same = f === to_;
        return (
          <div
            key={i}
            className="relative flex items-center whitespace-pre"
            style={{ minHeight: linePx }}
          >
            <span
              className="mr-4 shrink-0 select-none text-right text-slate-400"
              style={{ width: Math.max(24, fontSizePx * 2) }}
            >
              {i + 1}
            </span>
            <span className="relative block min-w-0">
              <span
                className="block"
                style={{
                  opacity: same ? 1 : 1 - t,
                  transform: `translateY(${same ? 0 : -6 * t}px)`,
                  transition: "opacity 60ms linear, transform 60ms linear",
                }}
              >
                {tokenize(f).map((tok, j) => (
                  <span key={j} className={tokenClass(tok.kind)}>
                    {tok.text}
                  </span>
                ))}
              </span>
              {!same && (
                <span
                  className="absolute left-0 top-0 block"
                  style={{
                    opacity: t,
                    transform: `translateY(${6 * (1 - t)}px)`,
                    transition: "opacity 60ms linear, transform 60ms linear",
                  }}
                >
                  {tokenize(to_).map((tok, j) => (
                    <span key={j} className={tokenClass(tok.kind)}>
                      {tok.text}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ScrollCode({
  code,
  progress,
  fontSizePx = 14,
}: {
  code: string;
  progress: number;
  fontSizePx?: number;
}) {
  // Scroll long code upward. Total travel = content height minus viewport.
  const lines = code.split("\n").length;
  const lineH = Math.round(fontSizePx * 1.75);
  const viewportH = 360; // matches container height
  const contentH = lines * lineH + 32;
  const travel = Math.max(0, contentH - viewportH);
  const y = -travel * progress;
  return (
    <div
      className="font-mono will-change-transform"
      style={{
        fontSize: fontSizePx,
        lineHeight: `${lineH}px`,
        transform: `translateY(${y}px)`,
        transition: "transform 80ms linear",
      }}
    >
      <Highlighted text={code} fontSizePx={fontSizePx} />
    </div>
  );
}

function FlightCode({
  code,
  progress,
  fontSizePx = 14,
}: {
  code: string;
  progress: number;
  fontSizePx?: number;
}) {
  const lines = code.split("\n");
  const per = 1 / Math.max(1, lines.length);
  const linePx = Math.round(fontSizePx * 1.75);
  return (
    <div className="font-mono" style={{ fontSize: fontSizePx, lineHeight: `${linePx}px` }}>
      {lines.map((line, i) => {
        // stagger: each line fully in by (i+1)*per*0.9
        const local = Math.min(1, Math.max(0, (progress - i * per * 0.5) / (per * 1.2)));
        const dir = i % 2 === 0 ? -1 : 1;
        return (
          <div
            key={i}
            className="flex items-center whitespace-pre"
            style={{
              minHeight: linePx,
              opacity: local,
              transform: `translateX(${(1 - local) * 40 * dir}px)`,
              transition: "opacity 80ms linear, transform 80ms linear",
            }}
          >
            <span
              className="mr-4 shrink-0 select-none text-right text-slate-400"
              style={{ width: Math.max(24, fontSizePx * 2) }}
            >
              {i + 1}
            </span>
            <span className="min-w-0">
              {tokenize(line).map((tok, j) => (
                <span key={j} className={tokenClass(tok.kind)}>
                  {tok.text}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** ---------- Main component ---------- */

export function CodeScene({
  code,
  codeTo,
  language = "ts",
  variant,
  progress,
  title,
  embedded = false,
  typingSpeedCps,
  durationMs,
  codeOutput,
  codeRunDelayMs,
  codeOutputHoldMs,
  codeTypingBeats,
  fontSizePx = 14,
}: CodeSceneProps) {
  const windowTitle = title ?? `example.${language}`;
  const cps = typingSpeedCps ?? DEFAULT_CODE_TYPING_CPS;
  const size = Math.max(10, Math.min(48, Math.round(fontSizePx || 14)));
  const beats = useMemo(
    () =>
      resolveCodeTypingBeats({
        beats: codeTypingBeats,
        code,
        output: codeOutput,
        runDelayMs: codeRunDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS,
        outputHoldMs: codeOutputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS,
      }),
    [codeTypingBeats, code, codeOutput, codeRunDelayMs, codeOutputHoldMs],
  );
  const useBeats = variant === "typing" && beats.length > 0;
  const timeline = useMemo(
    () => (useBeats ? buildCodeBeatTimeline(beats, cps) : null),
    [useBeats, beats, cps],
  );
  const elapsedMs = (progress || 0) * Math.max(1, durationMs ?? 0);
  const frame =
    timeline != null ? resolveCodeBeatFrame(elapsedMs, timeline, cps) : null;

  const hasRun = useBeats && beats.some((b) => b.output.trim().length > 0);

  const codeScrollRef = useRef<HTMLDivElement>(null);
  const codeEndRef = useRef<HTMLSpanElement>(null);
  const outputScrollRef = useRef<HTMLPreElement>(null);

  /** Preview: allow manual Run after current beat typing finishes. */
  const [manualOutput, setManualOutput] = useState<string | null>(null);
  useEffect(() => {
    setManualOutput(null);
  }, [code, codeOutput, durationMs, codeTypingBeats]);

  const phase = frame?.runPhase ?? "idle";
  const showOutput = manualOutput != null || !!frame?.output;
  const outputText = manualOutput ?? frame?.output ?? "";

  // Keep the typing caret / latest lines in view as code grows.
  useEffect(() => {
    if (variant !== "typing") return;
    const end = codeEndRef.current;
    const box = codeScrollRef.current;
    if (end) {
      end.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (box) box.scrollTop = box.scrollHeight;
  }, [
    variant,
    frame?.visibleCode,
    frame?.showCaret,
    progress,
    showOutput,
  ]);

  // Keep console output scrolled to the latest line.
  useEffect(() => {
    const pre = outputScrollRef.current;
    if (!pre || !showOutput) return;
    pre.scrollTop = pre.scrollHeight;
  }, [outputText, showOutput]);

  const runEnabled =
    hasRun &&
    (phase === "ready" ||
      phase === "pressing" ||
      phase === "done" ||
      (frame != null && !frame.typingActive && frame.visibleCode.length > 0));
  const runPressed = phase === "pressing";

  const editor = (
    <div
      className={
        embedded
          ? "flex h-full w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
          : "flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-red-400" />
        <span className="h-3 w-3 rounded-full bg-yellow-400" />
        <span className="h-3 w-3 rounded-full bg-green-400" />
        <span className="ml-3 min-w-0 flex-1 truncate font-mono text-xs text-slate-600">
          {windowTitle}
        </span>
        {hasRun ? (
          <button
            type="button"
            disabled={!runEnabled}
            onClick={() => {
              if (!runEnabled || !frame) return;
              const beat = beats[frame.beatIndex];
              if (beat?.output.trim()) setManualOutput(beat.output);
            }}
            className={`shrink-0 rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold tracking-wide transition ${
              runPressed
                ? "scale-95 bg-emerald-700 text-white"
                : showOutput
                  ? "bg-emerald-600 text-white"
                  : runEnabled
                    ? "bg-emerald-500 text-white hover:bg-emerald-600"
                    : "cursor-not-allowed bg-slate-200 text-slate-400"
            }`}
          >
            ▶ Run
          </button>
        ) : null}
      </div>
      <div
        ref={codeScrollRef}
        className={`relative min-h-0 flex-1 overflow-x-auto overflow-y-auto px-4 pb-3 pt-5 ${
          embedded ? "" : showOutput ? "h-[240px]" : "h-[360px]"
        }`}
      >
        {variant === "typing" && frame ? (
          <TypingCodeVisible
            code={frame.visibleCode}
            showCaret={frame.showCaret}
            endRef={codeEndRef}
            fontSizePx={size}
          />
        ) : null}
        {variant === "typing" && !frame ? (
          <TypingCode
            code={code}
            progress={progress}
            typingSpeedCps={typingSpeedCps}
            durationMs={durationMs}
            endRef={codeEndRef}
            fontSizePx={size}
          />
        ) : null}
        {variant === "morph" && (
          <MorphCode from={code} to={codeTo ?? code} progress={progress} fontSizePx={size} />
        )}
        {variant === "scroll" && (
          <ScrollCode code={code} progress={progress} fontSizePx={size} />
        )}
        {variant === "flight" && (
          <FlightCode code={code} progress={progress} fontSizePx={size} />
        )}
      </div>
      {hasRun && showOutput ? (
        <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Output
          </p>
          <pre
            ref={outputScrollRef}
            className="max-h-[140px] overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed text-slate-800"
            style={{ fontSize: Math.max(10, size - 1) }}
          >
            {outputText}
          </pre>
        </div>
      ) : null}
    </div>
  );

  if (embedded) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 md:p-6">
        {editor}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-white p-6">
      {editor}
    </div>
  );
}
