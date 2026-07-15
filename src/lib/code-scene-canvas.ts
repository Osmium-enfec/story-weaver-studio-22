import type { Scene } from "@/components/VideoPlayer";
import type { CodeVariant } from "@/components/CodeScene";
import { canvasFont } from "./scene-font";

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

  ctx.fillStyle = "#475569";
  ctx.font = canvasFont(400, Math.round(fontSize * 0.92));
  ctx.textBaseline = "middle";
  const titleX = dotX + Math.round(fontSize * 0.8);
  const maxTitleW = w - (titleX - x) - fontSize;
  let shown = title;
  while (shown.length > 0 && ctx.measureText(shown).width > maxTitleW) {
    shown = shown.slice(0, -1);
  }
  if (shown.length < title.length && shown.length > 1) shown = `${shown.slice(0, -1)}…`;
  ctx.fillText(shown, titleX, dotY);
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
  ctx.textBaseline = "top";
  for (const tok of tokenize(line)) {
    ctx.fillStyle = tokenColor(tok.kind);
    ctx.fillText(tok.text, cx, y);
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
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    ctx.fillText(String(idx + 1), contentX + lineNumW - 8, y);
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

  const total = code.length;
  const shown = Math.floor(total * Math.min(1, progress * 1.15));
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
  const fontSize = Math.max(12, Math.round(h * 0.038));
  const lineH = Math.round(fontSize * 1.5);
  const lineNumW = Math.round(fontSize * 2.2);
  const pad = Math.round(fontSize * 1.1);

  drawTitleBar(ctx, x, y, w, titleBarH, title, fontSize);

  const contentX = x + pad;
  const contentY = y + titleBarH + pad;
  const contentW = w - pad * 2;
  const contentH = h - titleBarH - pad * 2;

  ctx.save();
  roundRectPath(ctx, x, y + titleBarH, w, h - titleBarH, 0);
  ctx.clip();
  ctx.beginPath();
  ctx.rect(contentX, contentY, contentW, contentH);
  ctx.clip();

  const vis = visibleCodeForVariant(code, variant, progress, scene.codeTo);
  if (variant === "scroll") {
    const lines = code.split("\n");
    const contentTotalH = lines.length * lineH + pad;
    const travel = Math.max(0, contentTotalH - contentH);
    const scrollY = -travel * progress;
    ctx.save();
    ctx.translate(0, scrollY);
    drawCodeLines(ctx, lines, contentX, contentY, lineNumW, fontSize, lineH);
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

    if (variant === "typing") {
      const total = code.length;
      const shown = Math.floor(total * Math.min(1, progress * 1.15));
      if (shown < total) {
        const visible = code.slice(0, shown);
        const caretLines = visible.split("\n");
        const lastLine = caretLines[caretLines.length - 1] ?? "";
        const caretY = contentY + (caretLines.length - 1) * lineH;
        ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
        const caretX =
          contentX +
          lineNumW +
          ctx.measureText(lastLine).width +
          Math.round(fontSize * 0.15);
        ctx.fillStyle = "#334155";
        ctx.fillRect(caretX, caretY + 2, Math.max(2, fontSize * 0.12), fontSize * 0.85);
      }
    }
  }

  ctx.restore();
  ctx.restore();
}
