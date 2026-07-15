import type { QuestionSceneContent } from "@/lib/question-scene-layout";
import { canvasFont } from "@/lib/scene-font";
import {
  QUESTION_HINT_LABELS,
  QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
  QUESTION_REVEAL_STEPS,
  questionRevealProgress,
} from "@/lib/question-scene-layout";

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

function drawFadeGroup(
  ctx: CanvasRenderingContext2D,
  alpha: number,
  draw: () => void,
) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  draw();
  ctx.restore();
}

function drawChecklistIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  ctx.strokeStyle = "#166534";
  ctx.lineWidth = Math.max(1.2, size * 0.12);
  roundRectPath(ctx, x, y, size, size, size * 0.22);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + size * 0.22, y + size * 0.52);
  ctx.lineTo(x + size * 0.42, y + size * 0.72);
  ctx.lineTo(x + size * 0.78, y + size * 0.32);
  ctx.stroke();
  ctx.restore();
}

function drawInfoIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.save();
  ctx.strokeStyle = "#6b7280";
  ctx.fillStyle = "#6b7280";
  ctx.lineWidth = Math.max(1.2, r * 0.22);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.35, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.05);
  ctx.lineTo(cx, cy + r * 0.42);
  ctx.stroke();
  ctx.restore();
}

function drawEmptyMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  kind: QuestionSceneContent["kind"],
) {
  if (kind === "mcq") {
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = Math.max(1.5, size * 0.14);
    ctx.stroke();
  } else {
    roundRectPath(ctx, x, y, size, size, size * 0.22);
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = Math.max(1.5, size * 0.14);
    ctx.stroke();
  }
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number,
  maxLines: number,
): number {
  const words = text.split(/\s+/);
  let line = "";
  let cy = y;
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, cy);
      cy += lineH;
      lines++;
      line = word;
      if (lines >= maxLines) return cy;
    } else {
      line = test;
    }
  }
  if (line && lines < maxLines) {
    ctx.fillText(line, x, cy);
    cy += lineH;
  }
  return cy;
}

export function drawQuestionIntroScreen(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  introText = QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);
  const titleSize = Math.max(22, Math.round(Math.min(w, h) * 0.06));
  ctx.fillStyle = "#111827";
  ctx.font = canvasFont(700, titleSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(introText, x + w / 2, y + h / 2);
  ctx.restore();
}

export function drawMarkYourAnswersScreen(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  secondsLeft = 3,
  holdSeconds = 3,
  markText = "Mark your answers",
) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);

  const titleSize = Math.max(22, Math.round(Math.min(w, h) * 0.06));
  const timerSize = Math.max(48, Math.round(Math.min(w, h) * 0.16));
  const cx = x + w / 2;
  const cy = y + h / 2;

  ctx.fillStyle = "#111827";
  ctx.font = canvasFont(700, titleSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(markText, cx, cy - timerSize * 0.55);

  const ringR = timerSize * 0.72;
  ctx.beginPath();
  ctx.arc(cx, cy + timerSize * 0.35, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = Math.max(4, ringR * 0.08);
  ctx.stroke();

  const shown = Math.max(0, secondsLeft);
  ctx.fillStyle = "#2563eb";
  ctx.font = canvasFont(700, timerSize);
  ctx.fillText(String(shown || 0), cx, cy + timerSize * 0.35);

  ctx.fillStyle = "#6b7280";
  ctx.font = canvasFont(500, Math.max(12, titleSize * 0.55));
  ctx.fillText(`${holdSeconds}s`, cx, cy + timerSize * 0.35 + ringR + titleSize * 0.45);
  ctx.restore();
}

export function drawQuestionBoard(
  ctx: CanvasRenderingContext2D,
  content: QuestionSceneContent,
  progress: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);

  const padX = Math.round(w * 0.08);
  const padY = Math.round(h * 0.07);
  const innerW = w - padX * 2;

  const fontQuestion = Math.max(18, Math.round(h * 0.046));
  const fontHint = Math.max(11, Math.round(h * 0.028));
  const fontOption = Math.max(14, Math.round(h * 0.034));
  const fontLetter = Math.max(16, Math.round(h * 0.038));
  const markerSize = Math.max(14, Math.round(h * 0.028));
  const optionH = Math.max(42, Math.round(h * 0.095));
  const optionGap = Math.max(8, Math.round(h * 0.016));

  const questionY = y + padY;
  const hintY = questionY + fontQuestion * 3.2;
  const optionsY = hintY + fontHint * 2.4;

  drawFadeGroup(ctx, questionRevealProgress(progress, "question"), () => {
    ctx.fillStyle = "#111827";
    ctx.font = canvasFont(700, fontQuestion);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    wrapText(ctx, content.question, x + padX, questionY, innerW, fontQuestion * 1.22, 3);
  });

  drawFadeGroup(ctx, questionRevealProgress(progress, "hint"), () => {
    const iconR = fontHint * 0.55;
    drawInfoIcon(ctx, x + padX + iconR, hintY + iconR, iconR);
    ctx.fillStyle = "#6b7280";
    ctx.font = canvasFont(400, fontHint);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(QUESTION_HINT_LABELS[content.kind], x + padX + iconR * 2.8, hintY + iconR);
  });

  const letters = ["A", "B", "C", "D"] as const;
  letters.forEach((letter, i) => {
    const step = QUESTION_REVEAL_STEPS[i + 2];
    const alpha = questionRevealProgress(progress, step);
    const oy = optionsY + i * (optionH + optionGap);
    drawFadeGroup(ctx, alpha, () => {
      const ox = x + padX;
      const ow = innerW;
      roundRectPath(ctx, ox, oy, ow, optionH, Math.round(optionH * 0.22));
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = Math.max(1.5, ow * 0.004);
      ctx.stroke();

      const markerX = ox + Math.round(ow * 0.04);
      const markerY = oy + (optionH - markerSize) / 2;
      drawEmptyMarker(ctx, markerX, markerY, markerSize, content.kind);

      ctx.fillStyle = "#2563eb";
      ctx.font = canvasFont(700, fontLetter);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const letterX = markerX + markerSize + Math.round(ow * 0.03);
      ctx.fillText(letter, letterX, oy + optionH / 2);

      ctx.fillStyle = "#1f2937";
      ctx.font = canvasFont(400, fontOption);
      const textX = letterX + fontLetter * 1.4;
      ctx.fillText(content.options[i], textX, oy + optionH / 2);
    });
  });

  ctx.restore();
}
