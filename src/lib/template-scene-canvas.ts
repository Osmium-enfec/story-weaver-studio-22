import { createExportCanvas } from "@/lib/export-runtime";
import { canvasFont, ensureExcalifontLoaded } from "@/lib/scene-font";
import { COMPOSITE_ASPECT } from "@/lib/course-visual-style";

export type TemplateType = "text" | "countdown" | "typing";

export interface TemplateDrawOpts {
  type: TemplateType;
  text: string;
  color: string;
  /** Font size in CSS px at the canvas height (scaled with H). */
  fontSize: number;
  /** Countdown total seconds (countdown type). */
  countdownSec?: number;
  /** Exact elapsed ms for countdown rendering when available. */
  elapsedMs?: number;
  /**
   * 0..1 scene progress — used for countdown number and typing reveal.
   * Static text templates ignore this.
   */
  progress?: number;
}

const W_REF = 1920;
const H_REF = Math.round(W_REF / COMPOSITE_ASPECT);

export function templateCountdownDurationMs(countdownSec?: number): number {
  return Math.max(1, Math.round(countdownSec ?? 5)) * 1000;
}

/** 0..1 progress for the on-screen countdown digits (independent of narration length). */
export function templateCountdownProgress(
  elapsedMs: number,
  countdownSec?: number,
): number {
  const total = templateCountdownDurationMs(countdownSec);
  return Math.min(1, Math.max(0, elapsedMs / total));
}

export function templateCountdownRemaining(
  elapsedMs: number,
  countdownSec?: number,
): number {
  const totalSec = Math.max(1, Math.round(countdownSec ?? 5));
  const totalMs = totalSec * 1000;
  const clamped = Math.min(totalMs, Math.max(0, elapsedMs));
  if (clamped >= totalMs) return 0;
  return Math.max(1, totalSec - Math.floor(clamped / 1000));
}

/** Visible prefix for typing templates (finishes slightly before progress=1). */
export function templateTypingVisibleText(text: string, progress?: number): string {
  const full = text ?? "";
  if (!full) return "";
  const p = Math.min(1, Math.max(0, progress ?? 0));
  const shown = Math.floor(full.length * Math.min(1, p * 1.08));
  return full.slice(0, shown);
}

export function templateTypingComplete(text: string, progress?: number): boolean {
  const full = text ?? "";
  if (!full) return true;
  return templateTypingVisibleText(full, progress).length >= full.length;
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push("");
      continue;
    }
    const words = para.split(/\s+/);
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

function drawCenteredTextBlock(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  text: string,
  fontPx: number,
  color: string,
  maxW: number,
  showCaret: boolean,
): void {
  ctx.font = canvasFont(600, fontPx);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = wrapLines(ctx, text || " ", maxW);
  const lineH = fontPx * 1.3;
  const blockH = lines.length * lineH;
  const startY = H / 2 - blockH / 2;
  lines.forEach((ln, i) => {
    ctx.fillText(ln, W / 2, startY + i * lineH + lineH / 2);
  });
  if (showCaret) {
    const last = lines[lines.length - 1] ?? "";
    const caretW = Math.max(2, fontPx * 0.12);
    const caretH = fontPx * 0.9;
    const lastW = ctx.measureText(last).width;
    const caretX = W / 2 + lastW / 2 + fontPx * 0.08;
    const caretY = startY + (lines.length - 1) * lineH + lineH / 2 - caretH / 2;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(caretX, caretY, caretW, caretH);
    ctx.globalAlpha = 1;
  }
}

/** Draw a white-bg Excalifont template frame into an existing canvas.
 *  Call ensureExcalifontLoaded() before export loops. */
export function drawTemplateFrame(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  opts: TemplateDrawOpts,
): void {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const scale = H / H_REF;
  const fontPx = Math.max(16, Math.round(opts.fontSize * scale));
  const color = opts.color?.trim() || "#111111";
  const padX = W * 0.08;
  const maxW = W - padX * 2;

  if (opts.type === "countdown") {
    const totalSec = Math.max(1, Math.round(opts.countdownSec ?? 5));
    const countdownMs = totalSec * 1000;
    const elapsedMs =
      opts.elapsedMs != null
        ? Math.min(countdownMs, Math.max(0, opts.elapsedMs))
        : Math.min(countdownMs, Math.max(0, (opts.progress ?? 0) * countdownMs));
    const remaining = templateCountdownRemaining(elapsedMs, totalSec);
    const display = String(remaining);

    const label = opts.text.trim();
    if (label) {
      const labelSize = Math.max(18, Math.round(fontPx * 0.28));
      ctx.font = canvasFont(600, labelSize);
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const labelLines = wrapLines(ctx, label, maxW);
      const lineH = labelSize * 1.25;
      const blockH = labelLines.length * lineH;
      const startY = H * 0.28 - blockH / 2;
      labelLines.forEach((ln, i) => {
        ctx.fillText(ln, W / 2, startY + i * lineH + lineH / 2);
      });
    }

    ctx.font = canvasFont(700, fontPx);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(display, W / 2, H * 0.55);
  } else if (opts.type === "typing") {
    const full = opts.text || "Your text here";
    const visible = templateTypingVisibleText(full, opts.progress ?? 0);
    const showCaret = !templateTypingComplete(full, opts.progress ?? 0);
    drawCenteredTextBlock(ctx, W, H, visible || " ", fontPx, color, maxW, showCaret);
  } else {
    drawCenteredTextBlock(
      ctx,
      W,
      H,
      opts.text.trim() || "Your text here",
      fontPx,
      color,
      maxW,
      false,
    );
  }

  ctx.restore();
}

/** Preview / thumbnail PNG for the compose UI. */
export async function renderTemplatePreviewDataUrl(
  opts: TemplateDrawOpts,
  width = 960,
): Promise<string> {
  await ensureExcalifontLoaded();
  const W = width;
  const H = Math.round(W / COMPOSITE_ASPECT);
  const canvas = createExportCanvas(W, H) as HTMLCanvasElement;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const progress =
    opts.progress ??
    (opts.type === "countdown" ? 0 : opts.type === "typing" ? 0.55 : 0);
  drawTemplateFrame(ctx, W, H, { ...opts, progress });
  return canvas.toDataURL("image/png");
}

export { W_REF as TEMPLATE_REF_WIDTH, H_REF as TEMPLATE_REF_HEIGHT };
