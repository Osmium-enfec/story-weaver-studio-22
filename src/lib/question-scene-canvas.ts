import type { QuestionSceneContent } from "@/lib/question-scene-layout";
import { canvasFont } from "@/lib/scene-font";
import {
  codingRevealProgress,
  QUESTION_BG_GRADIENT_STOPS,
  QUESTION_HINT_LABELS,
  QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
  QUESTION_OPTION_ACCENT,
  questionOptionMode,
  questionRevealProgress,
  questionRevealStepsFor,
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
  mode: "mcq" | "msq",
) {
  if (mode === "msq") {
    roundRectPath(ctx, x, y, size, size, size * 0.22);
    ctx.strokeStyle = QUESTION_OPTION_ACCENT;
    ctx.lineWidth = Math.max(1.5, size * 0.14);
    ctx.stroke();
    return;
  }
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.strokeStyle = QUESTION_OPTION_ACCENT;
  ctx.lineWidth = Math.max(1.5, size * 0.14);
  ctx.stroke();
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

/** Height of wrapped text without drawing (for vertical centering). */
function measureWrapHeight(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  lineH: number,
  maxLines: number,
): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return lineH;
  let line = "";
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines++;
      line = word;
      if (lines >= maxLines) return lines * lineH;
    } else {
      line = test;
    }
  }
  if (line && lines < maxLines) lines++;
  return Math.max(1, lines) * lineH;
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

function questionOrangeGradient(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  const stops = QUESTION_BG_GRADIENT_STOPS;
  g.addColorStop(0, stops[0]);
  g.addColorStop(0.5, stops[1]);
  g.addColorStop(1, stops[2]);
  return g;
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
  const ringR = timerSize * 0.72;
  const holdLabelSize = Math.max(12, titleSize * 0.55);
  const gapTitleToRing = Math.round(timerSize * 0.85);
  const gapRingToHold = Math.round(titleSize * 0.7);

  // Vertically center the whole stack (title + gap + ring + hold label).
  const stackH =
    titleSize + gapTitleToRing + ringR * 2 + gapRingToHold + holdLabelSize;
  const stackTop = y + (h - stackH) / 2 - Math.round(h * 0.03); // nudge group slightly up
  const titleY = stackTop + titleSize / 2;
  const ringCy = stackTop + titleSize + gapTitleToRing + ringR;
  const holdY = ringCy + ringR + gapRingToHold + holdLabelSize / 2;
  const cx = x + w / 2;

  ctx.fillStyle = "#111827";
  ctx.font = canvasFont(700, titleSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(markText, cx, titleY);

  const lineW = Math.max(4, ringR * 0.08);
  ctx.beginPath();
  ctx.arc(cx, ringCy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = lineW;
  ctx.stroke();

  const shown = Math.max(0, secondsLeft);
  const frac = holdSeconds > 0 ? Math.min(1, shown / holdSeconds) : 0;
  const grad = questionOrangeGradient(ctx, cx - ringR, ringCy, cx + ringR, ringCy);
  if (frac > 0) {
    ctx.beginPath();
    ctx.arc(cx, ringCy, ringR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = grad;
    ctx.lineWidth = lineW;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  ctx.fillStyle = grad;
  ctx.font = canvasFont(700, timerSize);
  ctx.fillText(String(shown || 0), cx, ringCy);

  ctx.fillStyle = "#6b7280";
  ctx.font = canvasFont(500, holdLabelSize);
  ctx.fillText(`${holdSeconds}s`, cx, holdY);
  ctx.restore();
}

/** Matches preview `font-sans` / `font-mono` (not Excalifont). */
function codingUiFont(weight: number | string, sizePx: number): string {
  return `${weight} ${Math.round(sizePx)}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

function codingMonoFont(weight: number | string, sizePx: number): string {
  return `${weight} ${Math.round(sizePx)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;
}

/** Wrap text while preserving explicit newlines (preview uses whitespace-pre-wrap). */
function wrapTextPreserveNewlines(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number,
  maxLines: number,
): number {
  let cy = y;
  let linesUsed = 0;
  for (const paragraph of text.split("\n")) {
    if (linesUsed >= maxLines) break;
    if (!paragraph) {
      cy += lineH;
      linesUsed++;
      continue;
    }
    const before = cy;
    cy = wrapText(ctx, paragraph, x, cy, maxW, lineH, maxLines - linesUsed);
    linesUsed += Math.max(1, Math.round((cy - before) / lineH));
  }
  return cy;
}

function drawCodingProblemBoard(
  ctx: CanvasRenderingContext2D,
  content: QuestionSceneContent,
  progress: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.save();
  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(x, y, w, h);

  const leftW = Math.round(w * 0.42);
  const rightX = x + leftW;
  const rightW = w - leftW;
  const testsAlpha = codingRevealProgress(progress, "tests");
  // Preview collapses the test pane until it fades in — code then fills the right column.
  const codeH = testsAlpha > 0 ? Math.round(h * (1.35 / 2.35)) : h;
  const testsY = y + codeH;
  const testsH = h - codeH;
  const pad = Math.max(8, Math.round(Math.min(w, h) * 0.018));
  const fontTitle = Math.max(12, Math.round(h * 0.032));
  const fontBody = Math.max(9, Math.round(h * 0.022));
  const fontUi = Math.max(8, Math.round(h * 0.018));
  const fontMono = Math.max(8, Math.round(h * 0.02));
  const headerH = Math.max(22, Math.round(h * 0.048));

  drawFadeGroup(ctx, codingRevealProgress(progress, "problem"), () => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, leftW, h);
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rightX, y);
    ctx.lineTo(rightX, y + h);
    ctx.stroke();

    let cy = y + pad;
    const title = content.codingTitle || content.subtitle || "Coding Problem";
    ctx.fillStyle = "#111827";
    ctx.font = codingUiFont(600, fontTitle);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    cy = wrapTextPreserveNewlines(ctx, title, x + pad, cy, leftW - pad * 2, fontTitle * 1.25, 3);
    cy += pad * 0.6;
    if (content.question.trim()) {
      ctx.fillStyle = "#374151";
      ctx.font = codingUiFont(400, fontBody);
      wrapTextPreserveNewlines(
        ctx,
        content.question,
        x + pad,
        cy,
        leftW - pad * 2,
        fontBody * 1.35,
        16,
      );
    }
  });

  drawFadeGroup(ctx, codingRevealProgress(progress, "code"), () => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rightX, y, rightW, codeH);

    // Header: Code badge + Auto (matches CodingProblemScene)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rightX, y, rightW, headerH);
    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rightX, y + headerH);
    ctx.lineTo(rightX + rightW, y + headerH);
    ctx.stroke();

    const badgePadX = Math.max(6, Math.round(pad * 0.7));
    const badgePadY = Math.max(3, Math.round(pad * 0.35));
    ctx.font = codingUiFont(500, fontUi);
    const badgeLabel = "Code";
    const badgeW = ctx.measureText(badgeLabel).width + badgePadX * 2;
    const badgeH = fontUi + badgePadY * 2;
    const badgeX = rightX + pad;
    const badgeY = y + (headerH - badgeH) / 2;
    roundRectPath(ctx, badgeX, badgeY, badgeW, badgeH, 4);
    ctx.fillStyle = "#f9fafb";
    ctx.fill();
    ctx.strokeStyle = "#e5e7eb";
    ctx.stroke();
    ctx.fillStyle = "#374151";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeLabel, badgeX + badgePadX, badgeY + badgeH / 2);

    ctx.fillStyle = "#9ca3af";
    ctx.font = codingUiFont(400, fontUi);
    ctx.textAlign = "right";
    ctx.fillText("Auto", rightX + rightW - pad, y + headerH / 2);

    const editorY = y + headerH;
    const editorH = codeH - headerH;
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(rightX, editorY, rightW, editorH);

    const lines = (content.codingStarterCode || "").split("\n").slice(0, 18);
    const lineH = Math.max(12, Math.round(fontMono * 1.55));
    const gutterW = Math.max(22, Math.round(pad * 2.2));
    ctx.font = codingMonoFont(400, fontMono);
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
      const ly = editorY + pad * 0.55 + i * lineH;
      if (ly + lineH > editorY + editorH) return;
      ctx.fillStyle = "#858585";
      ctx.textAlign = "right";
      ctx.fillText(String(i + 1), rightX + gutterW, ly);
      ctx.fillStyle = "#d4d4d4";
      ctx.textAlign = "left";
      ctx.fillText(line || " ", rightX + gutterW + pad * 0.55, ly);
    });
  });

  drawFadeGroup(ctx, testsAlpha, () => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rightX, testsY, rightW, testsH);
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.moveTo(rightX, testsY);
    ctx.lineTo(rightX + rightW, testsY);
    ctx.stroke();

    const rowH = Math.max(20, Math.round(h * 0.042));
    ctx.fillStyle = "#111827";
    ctx.font = codingUiFont(600, fontUi);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const testcaseLabel = "Testcase";
    ctx.fillText(testcaseLabel, rightX + pad, testsY + rowH / 2);
    const testcaseW = ctx.measureText(testcaseLabel).width;
    ctx.fillStyle = "#9ca3af";
    ctx.font = codingUiFont(400, fontUi);
    ctx.fillText("Test Result", rightX + pad + testcaseW + pad, testsY + rowH / 2);

    ctx.strokeStyle = "#f3f4f6";
    ctx.beginPath();
    ctx.moveTo(rightX, testsY + rowH);
    ctx.lineTo(rightX + rightW, testsY + rowH);
    ctx.stroke();

    const tests = (content.codingTestCases ?? []).filter(
      (t) => t.input.trim() || t.output.trim(),
    );
    const tabs = tests.length ? tests : [{ label: "Case 1", input: "", output: "" }];
    let tabX = rightX + pad;
    const tabY = testsY + rowH + pad * 0.35;
    const tabH = Math.max(16, Math.round(fontUi * 1.7));
    tabs.slice(0, 3).forEach((t, i) => {
      const label = t.label || `Case ${i + 1}`;
      ctx.font = codingUiFont(i === 0 ? 500 : 400, fontUi);
      const tw = ctx.measureText(label).width + pad;
      if (i === 0) {
        roundRectPath(ctx, tabX, tabY, tw, tabH, 4);
        ctx.fillStyle = "#f3f4f6";
        ctx.fill();
      }
      ctx.fillStyle = i === 0 ? "#1f2937" : "#6b7280";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tabX + pad * 0.4, tabY + tabH / 2);
      tabX += tw + pad * 0.35;
    });

    ctx.strokeStyle = "#f3f4f6";
    ctx.beginPath();
    ctx.moveTo(rightX, tabY + tabH + pad * 0.35);
    ctx.lineTo(rightX + rightW, tabY + tabH + pad * 0.35);
    ctx.stroke();

    let by = tabY + tabH + pad * 0.7;
    const active = tabs[0];
    const boxMaxW = rightW - pad * 2;
    const drawIoBlock = (label: string, value: string) => {
      ctx.fillStyle = "#6b7280";
      ctx.font = codingUiFont(500, fontUi);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(label, rightX + pad, by);
      by += fontUi * 1.35;
      const valueLines = value.split("\n").slice(0, 4);
      const boxPad = Math.max(4, Math.round(pad * 0.45));
      const valueLineH = fontMono * 1.35;
      const boxH = boxPad * 2 + valueLines.length * valueLineH;
      roundRectPath(ctx, rightX + pad, by, boxMaxW, boxH, 4);
      ctx.fillStyle = "#f9fafb";
      ctx.fill();
      ctx.strokeStyle = "#e5e7eb";
      ctx.stroke();
      ctx.fillStyle = "#1f2937";
      ctx.font = codingMonoFont(400, fontMono);
      valueLines.forEach((vl, i) => {
        ctx.fillText(vl, rightX + pad + boxPad, by + boxPad + i * valueLineH);
      });
      by += boxH + pad * 0.55;
    };

    if (active && (active.input.trim() || active.output.trim())) {
      if (active.input.trim()) drawIoBlock("Input =", active.input);
      if (active.output.trim()) drawIoBlock("Output =", active.output);
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.font = codingUiFont(400, fontUi);
      ctx.textBaseline = "top";
      ctx.fillText("Add test case inputs…", rightX + pad, by);
    }
  });

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
  if (content.kind === "coding") {
    drawCodingProblemBoard(ctx, content, progress, x, y, w, h);
    return;
  }

  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);

  const isPredict = content.kind === "predictOutput";
  const revealSteps = questionRevealStepsFor(content.kind);
  const optionMode = questionOptionMode(content);
  const hintLabel =
    isPredict
      ? optionMode === "msq"
        ? "Select all that apply."
        : "Select one answer."
      : QUESTION_HINT_LABELS[content.kind];

  const padX = Math.round(w * 0.08);
  const padY = Math.round(h * 0.07);
  const innerW = w - padX * 2;

  const fontQuestion = Math.max(18, Math.round(h * 0.046));
  const fontHint = Math.max(11, Math.round(h * 0.028));
  const fontOption = Math.max(14, Math.round(h * 0.034));
  const fontLetter = Math.max(16, Math.round(h * 0.038));
  const fontCode = Math.max(10, Math.round(h * 0.022));
  const markerSize = Math.max(14, Math.round(h * 0.028));
  const optionH = Math.max(42, Math.round(h * (isPredict ? 0.08 : 0.095)));
  const optionGap = Math.max(8, Math.round(h * 0.016));
  const gapQuestionToHint = Math.round(fontQuestion * 0.55);
  const gapHintToOptions = Math.round(fontHint * 1.4);
  const codeLines = isPredict
    ? (content.predictCode ?? "").replace(/\r\n/g, "\n").split("\n").slice(0, 8)
    : [];
  const codeLineH = fontCode * 1.35;
  const codeBlockH = isPredict
    ? codeLines.length * codeLineH + Math.round(h * 0.028)
    : 0;
  const gapAfterCode = isPredict ? Math.round(h * 0.02) : 0;

  // Measure question wrap so we can vertically center the full MCQ/MSQ block.
  ctx.font = canvasFont(700, fontQuestion);
  const questionLineH = fontQuestion * 1.22;
  const questionBlockH = measureWrapHeight(
    ctx,
    content.question,
    innerW,
    questionLineH,
    3,
  );
  const hintBlockH = fontHint * 1.1;
  const optionsBlockH = 4 * optionH + 3 * optionGap;
  const contentH =
    questionBlockH +
    (isPredict ? gapAfterCode + codeBlockH + gapAfterCode : gapQuestionToHint) +
    hintBlockH +
    gapHintToOptions +
    optionsBlockH;
  const contentTop = y + Math.max(padY, Math.round((h - contentH) / 2));

  const questionY = contentTop;
  const codeY = questionY + questionBlockH + gapAfterCode;
  const hintY = isPredict
    ? codeY + codeBlockH + gapAfterCode
    : questionY + questionBlockH + gapQuestionToHint;
  const optionsY = hintY + hintBlockH + gapHintToOptions;

  drawFadeGroup(ctx, questionRevealProgress(progress, "question", revealSteps), () => {
    ctx.fillStyle = "#111827";
    ctx.font = canvasFont(700, fontQuestion);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    wrapText(ctx, content.question, x + padX, questionY, innerW, questionLineH, 3);
  });

  if (isPredict) {
    drawFadeGroup(ctx, questionRevealProgress(progress, "code", revealSteps), () => {
      const ox = x + padX;
      roundRectPath(ctx, ox, codeY, innerW, codeBlockH, 10);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = Math.max(1, h * 0.002);
      ctx.stroke();
      ctx.font = `400 ${fontCode}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const textTop = codeY + Math.round(fontCode * 0.55);
      codeLines.forEach((line, i) => {
        ctx.fillStyle = "#9ca3af";
        ctx.fillText(String(i + 1), ox + 8, textTop + i * codeLineH);
        ctx.fillStyle = "#1f2937";
        ctx.fillText(line || " ", ox + 28, textTop + i * codeLineH);
      });
    });
  }

  drawFadeGroup(ctx, questionRevealProgress(progress, "hint", revealSteps), () => {
    const iconR = fontHint * 0.55;
    drawInfoIcon(ctx, x + padX + iconR, hintY + iconR, iconR);
    ctx.fillStyle = "#6b7280";
    ctx.font = canvasFont(400, fontHint);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(hintLabel, x + padX + iconR * 2.8, hintY + iconR);
  });

  const letters = ["A", "B", "C", "D"] as const;
  letters.forEach((letter, i) => {
    const step = `option-${letter.toLowerCase()}`;
    const alpha = questionRevealProgress(progress, step, revealSteps);
    const oy = optionsY + i * (optionH + optionGap);
    drawFadeGroup(ctx, alpha, () => {
      const ox = x + padX;
      const ow = innerW;
      roundRectPath(ctx, ox, oy, ow, optionH, Math.round(optionH * 0.22));
      ctx.strokeStyle = questionOrangeGradient(ctx, ox, oy, ox + ow, oy);
      ctx.lineWidth = Math.max(2.5, ow * 0.005);
      ctx.stroke();

      const markerX = ox + Math.round(ow * 0.04);
      const markerY = oy + (optionH - markerSize) / 2;
      drawEmptyMarker(ctx, markerX, markerY, markerSize, optionMode);

      ctx.fillStyle = questionOrangeGradient(ctx, ox, oy, ox + ow * 0.35, oy);
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
