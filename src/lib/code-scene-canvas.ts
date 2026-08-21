import type { Scene } from "@/components/VideoPlayer";
import type { CodeVariant } from "@/components/CodeScene";
import { canvasFont } from "./scene-font";
import {
  buildCodeBeatTimeline,
  DEFAULT_CODE_OUTPUT_HOLD_MS,
  DEFAULT_CODE_TYPING_CPS,
  resolveCodeBeatFrame,
  resolveCodeTypingBeats,
  typingVisibleChars,
} from "./code-scene-sfx";

type TokKind = "kw" | "str" | "num" | "com" | "fn" | "pun" | "txt";

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "class", "extends", "new", "import", "from", "export", "default", "async",
  "await", "try", "catch", "throw", "typeof", "instanceof", "in", "of",
  "true", "false", "null", "undefined", "this", "def", "self", "print",
  "lambda", "None", "True", "False", "elif", "pass", "yield", "with", "as",
  "interface", "type", "enum", "public", "private", "protected", "static",
]);

function tokenize(line: string): { text: string; kind: TokKind }[] {
  const tokens: { text: string; kind: TokKind }[] = [];
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
  let prev: { text: string; kind: TokKind } | null = null;
  while ((m = re.exec(codePart)) !== null) {
    const t = m[0];
    let kind: TokKind = "txt";
    if (/^["'`]/.test(t)) kind = "str";
    else if (/^\d/.test(t)) kind = "num";
    else if (/^[A-Za-z_$]/.test(t)) {
      if (KEYWORDS.has(t)) kind = "kw";
      else {
        const rest = codePart.slice(re.lastIndex);
        if (/^\s*\(/.test(rest)) kind = "fn";
      }
    } else if (/^[{}()[\];,.:=+\-*/%<>!?&|]/.test(t)) kind = "pun";
    const tok = { text: t, kind };
    if (prev && prev.kind === kind && (kind === "txt" || kind === "pun")) prev.text += t;
    else {
      tokens.push(tok);
      prev = tok;
    }
  }
  if (comment) tokens.push({ text: comment, kind: "com" });
  return tokens;
}

function tokenColor(kind: TokKind): string {
  switch (kind) {
    case "kw": return "#9333ea";
    case "str": return "#059669";
    case "num": return "#d97706";
    case "com": return "#94a3b8";
    case "fn": return "#0284c7";
    case "pun": return "#64748b";
    default: return "#1e293b";
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTitleBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  fontSize: number,
  run?: { phase: "idle" | "ready" | "pressing" | "done" },
) {
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.stroke();

  const dotR = Math.max(4, Math.round(h * 0.18));
  const dotY = y + h / 2;
  let dotX = x + Math.round(fontSize * 1.1);
  const dotColors = ["#f87171", "#facc15", "#4ade80"];
  for (const color of dotColors) {
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fill();
    dotX += dotR * 2 + Math.round(fontSize * 0.55);
  }

  const runBtnW = run ? Math.round(fontSize * 4.2) : 0;
  const runBtnH = Math.round(h * 0.58);
  const runPad = Math.round(fontSize * 0.7);
  const runBtnX = run ? x + w - runPad - runBtnW : x + w;
  const runBtnY = y + (h - runBtnH) / 2;

  ctx.fillStyle = "#475569";
  ctx.font = canvasFont(400, Math.round(fontSize * 0.92));
  ctx.textBaseline = "middle";
  const titleX = dotX + Math.round(fontSize * 0.8);
  const maxTitleW = runBtnX - titleX - fontSize * 0.5;
  let shown = title;
  while (shown.length > 0 && ctx.measureText(shown).width > maxTitleW) {
    shown = shown.slice(0, -1);
  }
  if (shown.length < title.length && shown.length > 1) shown = `${shown.slice(0, -1)}…`;
  ctx.fillText(shown, titleX, dotY);

  if (run) {
    const phase = run.phase;
    const fill =
      phase === "idle"
        ? "#e2e8f0"
        : phase === "pressing"
          ? "#047857"
          : "#10b981";
    const text = phase === "idle" ? "#94a3b8" : "#ffffff";
    const scale = phase === "pressing" ? 0.94 : 1;
    const bw = runBtnW * scale;
    const bh = runBtnH * scale;
    const bx = runBtnX + (runBtnW - bw) / 2;
    const by = runBtnY + (runBtnH - bh) / 2;
    roundRectPath(ctx, bx, by, bw, bh, Math.round(bh * 0.22));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = text;
    ctx.font = `${Math.round(fontSize * 0.72)}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("▶ Run", bx + bw / 2, by + bh / 2 + 0.5);
    ctx.textAlign = "left";
  }
}

function drawOutputPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  output: string,
  fontSize: number,
) {
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();

  const pad = Math.round(fontSize * 0.9);
  ctx.fillStyle = "#64748b";
  ctx.font = `${Math.round(fontSize * 0.65)}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textBaseline = "top";
  ctx.fillText("OUTPUT", x + pad, y + Math.round(pad * 0.55));

  const lineH = Math.round(fontSize * 1.35);
  let ly = y + Math.round(pad * 1.55);
  ctx.fillStyle = "#1e293b";
  ctx.font = `${Math.round(fontSize * 0.85)}px ui-monospace, "SF Mono", Menlo, monospace`;
  const maxW = w - pad * 2;
  for (const rawLine of output.replace(/\r\n/g, "\n").split("\n")) {
    if (ly + lineH > y + h - pad * 0.4) break;
    let line = rawLine;
    while (line.length > 0 && ctx.measureText(line).width > maxW) {
      let cut = line.length;
      while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxW) cut -= 1;
      ctx.fillText(line.slice(0, cut), x + pad, ly);
      ly += lineH;
      line = line.slice(cut);
      if (ly + lineH > y + h - pad * 0.4) break;
    }
    if (ly + lineH > y + h - pad * 0.4) break;
    ctx.fillText(line, x + pad, ly);
    ly += lineH;
  }
}

function drawHighlightedLine(
  ctx: CanvasRenderingContext2D,
  line: string,
  x: number,
  y: number,
  fontSize: number,
) {
  let cx = x;
  ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
  // Alphabetic baseline with vertical centering in the line box avoids
  // clipping tall glyphs (e.g. `{`) against a tight top clip edge.
  ctx.textBaseline = "alphabetic";
  const baseline = y + Math.round(fontSize * 0.85);
  for (const tok of tokenize(line)) {
    ctx.fillStyle = tokenColor(tok.kind);
    ctx.fillText(tok.text, cx, baseline);
    cx += ctx.measureText(tok.text).width;
  }
}

function drawCodeLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  contentX: number,
  contentY: number,
  lineNumW: number,
  fontSize: number,
  lineH: number,
  startLineIndex = 0,
  lineOpacity?: (index: number) => number,
  lineOffsetX?: (index: number) => number,
) {
  lines.forEach((line, i) => {
    const idx = startLineIndex + i;
    const opacity = lineOpacity ? lineOpacity(idx) : 1;
    if (opacity <= 0) return;
    const offsetX = lineOffsetX ? lineOffsetX(idx) : 0;
    const y = contentY + i * lineH;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(offsetX, 0);
    ctx.fillStyle = "#94a3b8";
    ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "right";
    const baseline = y + Math.round(fontSize * 0.85);
    ctx.fillText(String(idx + 1), contentX + lineNumW - 8, baseline);
    ctx.textAlign = "left";
    drawHighlightedLine(ctx, line, contentX + lineNumW, y, fontSize);
    ctx.restore();
  });
}

function visibleCodeForVariant(
  code: string,
  variant: CodeVariant,
  progress: number,
  codeTo?: string,
  typingOpts?: { cps?: number; durationMs?: number },
): { lines: string[]; lineOpacity?: (i: number) => number; lineOffsetX?: (i: number) => number; scrollY?: number } {
  if (variant === "scroll") {
    return { lines: code.split("\n"), scrollY: 0 };
  }
  if (variant === "flight") {
    const lines = code.split("\n");
    const per = 1 / Math.max(1, lines.length);
    return {
      lines,
      lineOpacity: (i) => Math.min(1, Math.max(0, (progress - i * per * 0.5) / (per * 1.2))),
      lineOffsetX: (i) => {
        const local = Math.min(1, Math.max(0, (progress - i * per * 0.5) / (per * 1.2)));
        const dir = i % 2 === 0 ? -1 : 1;
        return (1 - local) * 40 * dir;
      },
    };
  }
  if (variant === "morph") {
    const fromLines = code.split("\n");
    const toLines = (codeTo ?? code).split("\n");
    const max = Math.max(fromLines.length, toLines.length);
    const t = Math.min(1, Math.max(0, progress));
    const lines: string[] = [];
    for (let i = 0; i < max; i++) {
      lines.push(t >= 0.5 ? (toLines[i] ?? "") : (fromLines[i] ?? ""));
    }
    return { lines };
  }

  const shown = typingVisibleChars(code, progress, typingOpts);
  const visible = code.slice(0, shown);
  return { lines: visible.split("\n") };
}

export function drawCodeEditor(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const code = scene.code ?? "";
  const variant = scene.codeVariant ?? "typing";
  const language = scene.codeLanguage ?? "ts";
  const title = scene.subtitle ?? `example.${language}`;
  const cps = scene.codeTypingCps ?? DEFAULT_CODE_TYPING_CPS;
  const beats = resolveCodeTypingBeats({
    beats: scene.codeTypingBeats,
    code,
    output: scene.codeOutput,
    runDelayMs: scene.codeRunDelayMs,
    outputHoldMs: scene.codeOutputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS,
  });
  const useBeats = variant === "typing" && beats.length > 0;
  const timeline = useBeats ? buildCodeBeatTimeline(beats, cps) : null;
  const elapsedMs = progress * Math.max(1, scene.durationMs);
  const frame =
    timeline != null ? resolveCodeBeatFrame(elapsedMs, timeline, cps) : null;
  const hasRun = useBeats && beats.some((b) => b.output.trim().length > 0);
  const phase = frame?.runPhase ?? "idle";
  const showOutput = hasRun && !!frame?.output;
  const output = frame?.output ?? "";
  const radius = Math.round(Math.min(w, h) * 0.03);

  ctx.save();
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.stroke();

  const titleBarH = Math.max(36, Math.round(h * 0.1));
  const outputH = showOutput ? Math.max(72, Math.round(h * 0.28)) : 0;
  const fontSize = Math.max(12, Math.round(h * 0.038));
  // Extra line height so braces / tall glyphs aren't clipped at the top of line 1.
  const lineH = Math.round(fontSize * 1.7);
  const lineNumW = Math.round(fontSize * 2.2);
  const pad = Math.round(fontSize * 1.1);
  const contentTopPad = Math.round(fontSize * 0.35);

  drawTitleBar(
    ctx,
    x,
    y,
    w,
    titleBarH,
    title,
    fontSize,
    hasRun ? { phase } : undefined,
  );

  const contentX = x + pad;
  const contentY = y + titleBarH + pad + contentTopPad;
  const contentW = w - pad * 2;
  const contentH = h - titleBarH - outputH - pad * 2 - contentTopPad;

  ctx.save();
  // Clip to the body below the title bar (not flush to glyph tops).
  ctx.beginPath();
  ctx.rect(x, y + titleBarH, w, h - titleBarH - outputH);
  ctx.clip();
  ctx.beginPath();
  ctx.rect(contentX, contentY - contentTopPad, contentW, contentH + contentTopPad);
  ctx.clip();

  if (variant === "typing" && frame) {
    const lines = frame.visibleCode.split("\n");
    const contentTotalH = lines.length * lineH;
    const scrollY = Math.max(0, contentTotalH - contentH);
    ctx.save();
    ctx.translate(0, -scrollY);
    drawCodeLines(ctx, lines, contentX, contentY, lineNumW, fontSize, lineH);
    if (frame.showCaret) {
      const lastLine = lines[lines.length - 1] ?? "";
      const caretY = contentY + (lines.length - 1) * lineH;
      ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
      const caretX =
        contentX +
        lineNumW +
        ctx.measureText(lastLine).width +
        Math.round(fontSize * 0.15);
      ctx.fillStyle = "#334155";
      const caretTop = caretY + Math.round(fontSize * 0.15);
      ctx.fillRect(caretX, caretTop, Math.max(2, fontSize * 0.12), fontSize * 0.9);
    }
    ctx.restore();
  } else {
    const vis = visibleCodeForVariant(code, variant, progress, scene.codeTo, {
      cps: scene.codeTypingCps,
      durationMs: scene.durationMs,
    });
    if (variant === "scroll") {
      const lines = code.split("\n");
      const contentTotalH = lines.length * lineH + pad;
      const travel = Math.max(0, contentTotalH - contentH);
      const scrollY = -travel * progress;
      ctx.save();
      ctx.translate(0, scrollY);
      drawCodeLines(ctx, lines, contentX, contentY, lineNumW, fontSize, lineH);
      ctx.restore();
    } else if (variant === "typing") {
      const shown = typingVisibleChars(code, progress, {
        cps: scene.codeTypingCps,
        durationMs: scene.durationMs,
      });
      const visible = code.slice(0, shown);
      const caretLines = visible.split("\n");
      const contentTotalH = caretLines.length * lineH;
      const scrollY = Math.max(0, contentTotalH - contentH);
      ctx.save();
      ctx.translate(0, -scrollY);
      drawCodeLines(
        ctx,
        caretLines,
        contentX,
        contentY,
        lineNumW,
        fontSize,
        lineH,
      );
      if (shown < code.length) {
        const lastLine = caretLines[caretLines.length - 1] ?? "";
        const caretY = contentY + (caretLines.length - 1) * lineH;
        ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
        const caretX =
          contentX +
          lineNumW +
          ctx.measureText(lastLine).width +
          Math.round(fontSize * 0.15);
        ctx.fillStyle = "#334155";
        const caretTop = caretY + Math.round(fontSize * 0.15);
        ctx.fillRect(caretX, caretTop, Math.max(2, fontSize * 0.12), fontSize * 0.9);
      }
      ctx.restore();
    } else {
      drawCodeLines(
        ctx,
        vis.lines,
        contentX,
        contentY,
        lineNumW,
        fontSize,
        lineH,
        0,
        vis.lineOpacity,
        vis.lineOffsetX,
      );
    }
  }

  ctx.restore();

  if (showOutput) {
    drawOutputPanel(ctx, x, y + h - outputH, w, outputH, output, fontSize);
  }

  ctx.restore();
}
