import { useMemo } from "react";

export type CodeVariant = "typing" | "morph" | "scroll" | "flight";

export interface CodeSceneProps {
  code: string;
  codeTo?: string; // for "morph"
  language?: string; // "ts" | "js" | "py" | "tsx" | ...
  variant: CodeVariant;
  progress: number; // 0..1
  title?: string;
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
    case "kw": return "text-fuchsia-400";
    case "str": return "text-emerald-400";
    case "num": return "text-amber-400";
    case "com": return "text-slate-500 italic";
    case "fn": return "text-sky-400";
    case "pun": return "text-slate-400";
    default: return "text-slate-200";
  }
}

function Highlighted({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="flex whitespace-pre">
          <span className="mr-4 w-8 shrink-0 select-none text-right text-slate-600">
            {i + 1}
          </span>
          <span>
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

function TypingCode({ code, progress }: { code: string; progress: number }) {
  const total = code.length;
  const shown = Math.floor(total * Math.min(1, progress * 1.15));
  const visible = code.slice(0, shown);
  const showCaret = shown < total;
  return (
    <div className="font-mono text-sm leading-6">
      <Highlighted text={visible} />
      {showCaret && (
        <span className="ml-1 inline-block h-4 w-2 -translate-y-0.5 animate-pulse bg-sky-400 align-middle" />
      )}
    </div>
  );
}

function MorphCode({ from, to, progress }: { from: string; to: string; progress: number }) {
  // cross-fade + subtle slide, aligned line by line
  const fromLines = from.split("\n");
  const toLines = to.split("\n");
  const max = Math.max(fromLines.length, toLines.length);
  const t = Math.min(1, Math.max(0, progress));
  return (
    <div className="font-mono text-sm leading-6">
      {Array.from({ length: max }).map((_, i) => {
        const f = fromLines[i] ?? "";
        const to_ = toLines[i] ?? "";
        const same = f === to_;
        return (
          <div key={i} className="relative flex whitespace-pre">
            <span className="mr-4 w-8 shrink-0 select-none text-right text-slate-600">
              {i + 1}
            </span>
            <span className="relative block">
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

function ScrollCode({ code, progress }: { code: string; progress: number }) {
  // Scroll long code upward. Total travel = content height minus viewport.
  const lines = code.split("\n").length;
  const lineH = 24; // matches leading-6 text-sm
  const viewportH = 360; // matches container height
  const contentH = lines * lineH + 32;
  const travel = Math.max(0, contentH - viewportH);
  const y = -travel * progress;
  return (
    <div
      className="font-mono text-sm leading-6 will-change-transform"
      style={{ transform: `translateY(${y}px)`, transition: "transform 80ms linear" }}
    >
      <Highlighted text={code} />
    </div>
  );
}

function FlightCode({ code, progress }: { code: string; progress: number }) {
  const lines = code.split("\n");
  const per = 1 / Math.max(1, lines.length);
  return (
    <div className="font-mono text-sm leading-6">
      {lines.map((line, i) => {
        // stagger: each line fully in by (i+1)*per*0.9
        const local = Math.min(1, Math.max(0, (progress - i * per * 0.5) / (per * 1.2)));
        const dir = i % 2 === 0 ? -1 : 1;
        return (
          <div
            key={i}
            className="flex whitespace-pre"
            style={{
              opacity: local,
              transform: `translateX(${(1 - local) * 40 * dir}px)`,
              transition: "opacity 80ms linear, transform 80ms linear",
            }}
          >
            <span className="mr-4 w-8 shrink-0 select-none text-right text-slate-600">
              {i + 1}
            </span>
            <span>
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
}: CodeSceneProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-white p-6">
      <div className="w-full max-w-3xl overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-2xl">
        {/* window chrome */}
        <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
          <span className="h-3 w-3 rounded-full bg-red-500/80" />
          <span className="h-3 w-3 rounded-full bg-yellow-500/80" />
          <span className="h-3 w-3 rounded-full bg-green-500/80" />
          <span className="ml-3 text-xs text-slate-400">
            {title ?? `example.${language}`}
          </span>
        </div>
        {/* code viewport */}
        <div className="relative h-[360px] overflow-hidden p-4">
          {variant === "typing" && <TypingCode code={code} progress={progress} />}
          {variant === "morph" && (
            <MorphCode from={code} to={codeTo ?? code} progress={progress} />
          )}
          {variant === "scroll" && <ScrollCode code={code} progress={progress} />}
          {variant === "flight" && <FlightCode code={code} progress={progress} />}
        </div>
      </div>
    </div>
  );
}
