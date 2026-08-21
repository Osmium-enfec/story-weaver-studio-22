// Pure "draw one frame of scene X at time T" helpers.
// Extracted from render-video.ts so both live playback export and the
// ffmpeg rasterizer can share the same drawing code.

import type { Scene } from "@/components/VideoPlayer";
import {
  clampPlaybackRate,
  isCropOnlyScene,
  normalizeRecordingVideoSegments,
  recordingSegmentDurationMs,
} from "@/lib/compose-scene";
import {
  CARD_PADDING_FRAC,
  DEFAULT_BACKGROUND,
  backgroundToCanvasFill,
  type SceneBackground,
} from "./scene-background";
import { layoutFor } from "./scene-layouts";
import { expandBboxForReveal } from "./bbox-utils";
import { boxRevealOpacityAtMs, revealSpeechDurationMs } from "./reveal-schedule";
import { masterVisualAt, slideOffset } from "./scene-transition";
import { drawCodeEditor } from "./code-scene-canvas";
import { drawQuestionBoard, drawMarkYourAnswersScreen, drawQuestionIntroScreen } from "./question-scene-canvas";
import { drawTemplateFrame, templateCountdownProgress } from "./template-scene-canvas";
import { canvasFont, ensureExcalifontLoaded } from "./scene-font";
import {
  createExportCanvas,
  exportSourceSize,
  loadExportImage,
} from "./export-runtime";
import {
  sceneToQuestionContent,
  questionMarkSettingsFromScene,
  questionIntroSettingsFromScene,
  questionMarkCountdownMs,
  questionTimelineAt,
  markCountdownSeconds,
} from "./question-scene-layout";
import { recordingCameraAt, recordingCameraDrawRects } from "./recording-camera";
import {
  drawRecordingBlurRegion,
  normalizeRecordingBlurRegion,
} from "./recording-blur";
import {
  drawRecordingHighlight,
  normalizeRecordingHighlights,
} from "./recording-highlight";
import { detectAndCacheVideoContentCrop } from "./video-black-bars";

export interface DrawOptions {
  background?: SceneBackground;
  transparent?: Map<string, HTMLImageElement>;
  /** For background.kind === "video". Caller must seek/advance the element
   *  before calling drawSceneFrame; we just draw its current frame. */
  videoBg?: HTMLVideoElement;
  /** Cached still of the looped video bg (export uses this for stable frames). */
  videoBgFrame?: CanvasImageSource;
  /** Screen-recording still (ffmpeg-baked) — prefer over seeking HTMLVideoElement. */
  recordingFrame?: CanvasImageSource;
  /** Skip outer background — used when compositing slide layers over one shared bg. */
  contentOnly?: boolean;
  /** Question scenes: intro → question → mark-gap → mark */
  questionPhase?: "intro" | "intro-gap" | "question" | "mark-gap" | "mark";
  /** Elapsed ms within the mark-your-answers hold (for countdown). */
  markHoldElapsedMs?: number;
  /** Absolute speech-clock ms within the active scene (recording sync). */
  elapsedSpeechMs?: number;
}

/** Draw the shared outer background (video loop, gradient, or whiteboard). */
export function drawSceneBackground(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  opts: DrawOptions = {},
): void {
  const background = opts.background ?? DEFAULT_BACKGROUND;
  const customBg = background.kind !== "whiteboard";

  const videoSrc = opts.videoBgFrame ?? opts.videoBg;
  if (background.kind === "video" && videoSrc) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    drawContain(ctx, videoSrc, 0, 0, W, H, "cover");
  } else if (customBg) {
    backgroundToCanvasFill(ctx, background, W, H);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
  }
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}


export function loadImage(url: string): Promise<HTMLImageElement> {
  return loadExportImage(url).then((img) => img as HTMLImageElement);
}

export function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    const fail = () => reject(new Error(`Failed to load video: ${url}`));
    v.onerror = fail;
    v.onloadeddata = async () => {
      try {
        // Force a decoded frame — headless Chromium often leaves seeked frames blank
        // until play() has produced at least one frame.
        await v.play().catch(() => {});
        v.pause();
        if (!v.videoWidth || !v.videoHeight) {
          reject(new Error(`Video has no dimensions: ${url}`));
          return;
        }
        resolve(v);
      } catch (e) {
        reject(e);
      }
    };
  });
}

export interface SceneAssets {
  bg: Map<string, HTMLImageElement>;
  el: Map<string, HTMLImageElement>;
  vid: Map<string, HTMLVideoElement>;
  cov: Map<string, HTMLImageElement>;
}

export async function preloadSceneAssets(
  scenes: Scene[],
  opts?: { skipVideoUrls?: Set<string> },
): Promise<SceneAssets> {
  const bg = new Map<string, HTMLImageElement>();
  const el = new Map<string, HTMLImageElement>();
  const vid = new Map<string, HTMLVideoElement>();
  const cov = new Map<string, HTMLImageElement>();
  const skipVideo = opts?.skipVideoUrls;

  const jobs: Promise<void>[] = [];
  for (const s of scenes) {
    if (s.kind === "image") {
      if (s.backgroundUrl && !bg.has(s.backgroundUrl)) {
        const url = s.backgroundUrl;
        jobs.push(
          loadImage(url).then((img) => { bg.set(url, img); }).catch((e) => {
            console.warn("[export] image bg failed", url.slice(0, 160), e);
          }),
        );
      }
      for (const e of s.elements ?? []) {
        if (!el.has(e.mediaUrl)) {
          const url = e.mediaUrl;
          jobs.push(
            loadImage(url).then((img) => { el.set(url, img); }).catch((e) => {
              console.warn("[export] image element failed", url.slice(0, 160), e);
            }),
          );
        }
      }
      for (const c of s.revealCovers ?? []) {
        if (!cov.has(c.pngUrl)) {
          const url = c.pngUrl;
          jobs.push(
            loadImage(url).then((img) => { cov.set(url, img); }).catch(() => {}),
          );
        }
      }
    } else if ((s.kind === "stock" || s.kind === "recording") && s.mediaUrl) {
      const url = s.mediaUrl;
      if (skipVideo?.has(url)) continue;
      if (!vid.has(url)) {
        jobs.push(
          loadVideo(url).then((v) => { vid.set(url, v); }).catch(() => {}),
        );
      }
    }
  }
  await Promise.all([...jobs, ensureExcalifontLoaded()]);
  return { bg, el, vid, cov };
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  x: number, y: number, w: number, h: number,
  mode: "cover" | "contain" = "cover",
) {
  const { w: iw, h: ih } = exportSourceSize(img);
  if (!iw || !ih) return;
  const ir = iw / ih;
  const cr = w / h;
  let dw = w, dh = h;
  if ((mode === "cover") === ir > cr) { dh = h; dw = h * ir; }
  else { dw = w; dh = w / ir; }
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function drawImageSceneFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  W: number, H: number,
  assets: SceneAssets,
  opts: DrawOptions = {},
) {
  const background = opts.background ?? DEFAULT_BACKGROUND;
  const customBg = background.kind !== "whiteboard";

  if (!opts.contentOnly) {
    drawSceneBackground(ctx, W, H, opts);
  }

  const padX = customBg ? Math.round(W * CARD_PADDING_FRAC) : 0;
  const padY = customBg ? Math.round(H * CARD_PADDING_FRAC) : 0;
  const innerX = padX;
  const innerY = padY;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;

  // Inner card (white with rounded corners + soft shadow) hosts elements.
  ctx.save();
  if (customBg) {
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = Math.round(H * 0.03);
    ctx.shadowOffsetY = Math.round(H * 0.012);
    ctx.fillStyle = "#ffffff";
    roundRectPath(ctx, innerX, innerY, innerW, innerH, Math.round(Math.min(W, H) * 0.025));
    ctx.fill();
    ctx.shadowColor = "transparent";
    // Clip subsequent drawing to the card.
    roundRectPath(ctx, innerX, innerY, innerW, innerH, Math.round(Math.min(W, H) * 0.025));
    ctx.clip();
  }

  const cropOnly = isCropOnlyScene(scene);
  const bg =
    scene.backgroundUrl && !cropOnly
      ? assets.bg.get(scene.backgroundUrl) ?? null
      : null;
  if (bg || cropOnly) {
    const covers = scene.revealCovers ?? [];
    const aspect =
      scene.bgAspect ??
      (bg
        ? (() => {
            const s = exportSourceSize(bg);
            return s.w / Math.max(1, s.h);
          })()
        : 1536 / 1024);
    const cr = innerW / innerH;
    let dw: number;
    let dh: number;
    if (aspect > cr) {
      dw = innerW;
      dh = innerW / aspect;
    } else {
      dh = innerH;
      dw = innerH * aspect;
    }
    const dx = innerX + (innerW - dw) / 2;
    const dy = innerY + (innerH - dh) / 2;
    const durationMs = revealSpeechDurationMs(scene);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(dx, dy, dw, dh);

    if (covers.length > 0 && bg) {
      const size = exportSourceSize(bg);
      const iw = size.w || 1;
      const ih = size.h || 1;
      covers.forEach((c, i) => {
        const alpha = boxRevealOpacityAtMs(progress * durationMs, i, covers);
        if (alpha <= 0) return;
        const box = expandBboxForReveal(c.bbox);
        const bx = dx + box.x * dw;
        const by = dy + box.y * dh;
        const bw = box.w * dw;
        const bh = box.h * dh;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          bg,
          box.x * iw,
          box.y * ih,
          box.w * iw,
          box.h * ih,
          bx,
          by,
          bw,
          bh,
        );
        ctx.restore();
      });
    } else if (bg) {
      drawContain(ctx, bg, dx, dy, dw, dh, "contain");
    }
  }

  const rawElements = (scene.elements ?? [])
    .map((e) => {
      const img =
        (opts.transparent && opts.transparent.get(e.mediaUrl)) ??
        assets.el.get(e.mediaUrl);
      return img ? { img, el: e, transparent: !!opts.transparent?.get(e.mediaUrl) } : null;
    })
    .filter(
      (x): x is { img: HTMLImageElement; el: NonNullable<Scene["elements"]>[number]; transparent: boolean } => !!x,
    );
  const layout = layoutFor(rawElements.length);

  rawElements.forEach(({ img, el, transparent }, i) => {
    if (progress < el.appearAt) return;
    const bboxPos = el.bbox
      ? {
          x: el.bbox.x + el.bbox.w / 2,
          y: el.bbox.y + el.bbox.h / 2,
          w: el.bbox.w,
          h: el.bbox.h,
        }
      : null;
    const pos: { x: number; y: number; w: number; h?: number } =
      bboxPos ?? layout[i] ?? { x: el.x, y: el.y, w: el.w };
    const revealWindow = Math.max(0.02, 450 / Math.max(1, scene.durationMs));
    const p = Math.min(1, (progress - el.appearAt) / revealWindow);
    const eased = easeOutCubic(p);

    const useAspectLayout = cropOnly && !!scene.bgAspect;
    let layoutW = innerW;
    let layoutH = innerH;
    let originX = innerX;
    let originY = innerY;
    if (useAspectLayout) {
      const aspect = scene.bgAspect ?? 1536 / 1024;
      const cr = innerW / innerH;
      if (aspect > cr) {
        layoutW = innerW;
        layoutH = innerW / aspect;
      } else {
        layoutH = innerH;
        layoutW = innerH * aspect;
      }
      originX = innerX + (innerW - layoutW) / 2;
      originY = innerY + (innerH - layoutH) / 2;
    }

    const boxW = layoutW * pos.w;
    const boxH = pos.h != null ? layoutH * pos.h : boxW;
    const iw = img.naturalWidth || 1;
    const ih = img.naturalHeight || 1;
    const ratio = ih / iw;
    const boxRatio = boxH / boxW;
    let targetW: number, targetH: number;
    if (ratio > boxRatio) { targetH = boxH; targetW = boxH / ratio; }
    else { targetW = boxW; targetH = boxW * ratio; }
    const cx = originX + pos.x * layoutW;
    const cy = originY + pos.y * layoutH;

    let scale = 1, dx = 0, dy = 0;
    switch (el.anim) {
      case "pop": scale = 0.6 + 0.4 * eased; break;
      case "slide-up": dy = (1 - eased) * 40; break;
      case "slide-left": dx = (1 - eased) * -60; break;
      case "slide-right": dx = (1 - eased) * 60; break;
    }

    ctx.save();
    ctx.globalAlpha = eased;
    if (!transparent) ctx.globalCompositeOperation = "multiply";
    ctx.translate(cx + dx, cy + dy);
    ctx.scale(scale, scale);
    ctx.drawImage(img, -targetW / 2, -targetH / 2, targetW, targetH);
    ctx.restore();

    if (el.label && !el.bbox) {
      const labelSize = Math.max(18, Math.round(targetW * 0.09));
      ctx.save();
      ctx.globalAlpha = eased;
      ctx.font = canvasFont(700, labelSize);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const labelY = cy + dy + targetH / 2 - 4;
      ctx.lineWidth = Math.max(3, labelSize * 0.18);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.strokeText(el.label, cx + dx, labelY);
      ctx.fillStyle = "#1a1a1a";
      ctx.fillText(el.label, cx + dx, labelY);
      ctx.restore();
    }
  });

  ctx.restore();
}


export function drawCodeSceneFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  W: number, H: number,
  opts: DrawOptions = {},
) {
  const background = opts.background ?? DEFAULT_BACKGROUND;
  const customBg = background.kind !== "whiteboard";

  if (!opts.contentOnly) {
    drawSceneBackground(ctx, W, H, opts);
  }

  const padX = customBg ? Math.round(W * CARD_PADDING_FRAC) : 0;
  const padY = customBg ? Math.round(H * CARD_PADDING_FRAC) : 0;
  const innerX = padX;
  const innerY = padY;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;

  ctx.save();
  if (customBg) {
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = Math.round(H * 0.03);
    ctx.shadowOffsetY = Math.round(H * 0.012);
    ctx.fillStyle = "#ffffff";
    roundRectPath(ctx, innerX, innerY, innerW, innerH, Math.round(Math.min(W, H) * 0.025));
    ctx.fill();
    ctx.shadowColor = "transparent";
    roundRectPath(ctx, innerX, innerY, innerW, innerH, Math.round(Math.min(W, H) * 0.025));
    ctx.clip();
  }

  const editorPad = customBg
    ? Math.round(Math.min(innerW, innerH) * 0.05)
    : Math.round(Math.min(W, H) * 0.06);
  const editorX = innerX + editorPad;
  const editorY = innerY + editorPad;
  const editorW = (customBg ? innerW : W) - editorPad * 2;
  const editorH = (customBg ? innerH : H) - editorPad * 2;

  drawCodeEditor(ctx, scene, progress, editorX, editorY, editorW, editorH);
  ctx.restore();
}

export function drawQuestionSceneFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  W: number,
  H: number,
  opts: DrawOptions = {},
) {
  const content = sceneToQuestionContent(scene);
  if (!content) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    return;
  }

  const background = opts.background ?? DEFAULT_BACKGROUND;
  const customBg = background.kind !== "whiteboard";

  if (!opts.contentOnly) {
    drawSceneBackground(ctx, W, H, opts);
  }

  const padX = customBg ? Math.round(W * CARD_PADDING_FRAC) : 0;
  const padY = customBg ? Math.round(H * CARD_PADDING_FRAC) : 0;
  const innerX = padX;
  const innerY = padY;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;

  ctx.save();
  if (customBg) {
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = Math.round(H * 0.03);
    ctx.shadowOffsetY = Math.round(H * 0.012);
    ctx.fillStyle = "#ffffff";
    roundRectPath(ctx, innerX, innerY, innerW, innerH, Math.round(Math.min(W, H) * 0.025));
    ctx.fill();
    ctx.shadowColor = "transparent";
    roundRectPath(ctx, innerX, innerY, innerW, innerH, Math.round(Math.min(W, H) * 0.025));
    ctx.clip();
  }

  const boardPad = customBg
    ? Math.round(Math.min(innerW, innerH) * 0.04)
    : Math.round(Math.min(W, H) * 0.04);
  const boardX = innerX + boardPad;
  const boardY = innerY + boardPad;
  const boardW = (customBg ? innerW : W) - boardPad * 2;
  const boardH = (customBg ? innerH : H) - boardPad * 2;

  if (opts.questionPhase === "mark") {
    const settings = questionMarkSettingsFromScene(scene);
    const elapsed = opts.markHoldElapsedMs ?? 0;
    const secondsLeft = markCountdownSeconds(elapsed, settings.countdownMs);
    drawMarkYourAnswersScreen(
      ctx,
      boardX,
      boardY,
      boardW,
      boardH,
      secondsLeft,
      settings.countdownMs / 1000,
      settings.text,
    );
  } else if (opts.questionPhase === "intro" || opts.questionPhase === "intro-gap") {
    const intro = questionIntroSettingsFromScene(scene);
    drawQuestionIntroScreen(ctx, boardX, boardY, boardW, boardH, intro.text);
  } else {
    drawQuestionBoard(ctx, content, opts.questionPhase === "mark-gap" ? 1 : progress, boardX, boardY, boardW, boardH);
  }
  ctx.restore();
}

export function drawTemplateSceneFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  W: number,
  H: number,
  opts: DrawOptions = {},
) {
  const background = opts.background ?? DEFAULT_BACKGROUND;
  const customBg = background.kind !== "whiteboard";

  if (!opts.contentOnly) {
    drawSceneBackground(ctx, W, H, opts);
  }

  const padX = customBg ? Math.round(W * CARD_PADDING_FRAC) : 0;
  const padY = customBg ? Math.round(H * CARD_PADDING_FRAC) : 0;
  const innerX = padX;
  const innerY = padY;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;

  ctx.save();
  if (customBg) {
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = Math.round(H * 0.03);
    ctx.shadowOffsetY = Math.round(H * 0.012);
    ctx.fillStyle = "#ffffff";
    roundRectPath(ctx, innerX, innerY, innerW, innerH, Math.round(Math.min(W, H) * 0.025));
    ctx.fill();
    ctx.shadowColor = "transparent";
    roundRectPath(ctx, innerX, innerY, innerW, innerH, Math.round(Math.min(W, H) * 0.025));
    ctx.clip();
  }

  ctx.translate(customBg ? innerX : 0, customBg ? innerY : 0);
  const elapsedMs =
    scene.templateKind === "countdown"
      ? Math.round(progress * ((scene.templateCountdownSec ?? 5) * 1000))
      : undefined;
  drawTemplateFrame(ctx, customBg ? innerW : W, customBg ? innerH : H, {
    type:
      scene.templateKind === "countdown"
        ? "countdown"
        : scene.templateKind === "typing"
          ? "typing"
          : "text",
    text: scene.templateText ?? "",
    color: scene.templateColor ?? "#1a1a1a",
    fontSize: scene.templateFontSize ?? 72,
    countdownSec: scene.templateCountdownSec,
    elapsedMs,
    progress,
  });
  ctx.restore();
}

export function drawStockFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  W: number, H: number,
) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  drawContain(ctx, video, 0, 0, W, H, "cover");
}

/** Source time (seconds) for a recording scene at a speech-clock position. */
export function recordingSourceTimeSec(scene: Scene, elapsedSpeechMs: number): number {
  const segments = normalizeRecordingVideoSegments({
    videoSegments: scene.recordingVideoSegments,
    sourceDurationMs: scene.recordingSourceDurationMs ?? 0,
    trimStartMs: scene.recordingTrimStartMs ?? 0,
    trimEndMs: scene.recordingTrimEndMs ?? 0,
    videoOffsetMs: scene.recordingVideoOffsetMs ?? 0,
  });
  for (const seg of segments) {
    const timelineDur = recordingSegmentDurationMs(seg);
    const local = elapsedSpeechMs - seg.offsetMs;
    if (local >= 0 && local <= timelineDur) {
      const rate = clampPlaybackRate(seg.rate);
      return (seg.trimStartMs + local * rate) / 1000;
    }
  }
  // Past the last clip: hold the last source frame (not the first — that
  // restarts the bumper and looks like a freeze on a wrong still).
  const last = segments[segments.length - 1];
  if (!last) return 0;
  const rate = clampPlaybackRate(last.rate);
  const lastLocal = recordingSegmentDurationMs(last);
  return (last.trimStartMs + Math.max(0, lastLocal - 1) * rate) / 1000;
}

/** Active video segment + rate at clock, or null when outside all clips. */
export function recordingVideoAtClock(
  scene: Scene,
  elapsedSpeechMs: number,
): { sourceSec: number; rate: number; inWindow: boolean } {
  const segments = normalizeRecordingVideoSegments({
    videoSegments: scene.recordingVideoSegments,
    sourceDurationMs: scene.recordingSourceDurationMs ?? 0,
    trimStartMs: scene.recordingTrimStartMs ?? 0,
    trimEndMs: scene.recordingTrimEndMs ?? 0,
    videoOffsetMs: scene.recordingVideoOffsetMs ?? 0,
  });
  for (const seg of segments) {
    const timelineDur = recordingSegmentDurationMs(seg);
    const local = elapsedSpeechMs - seg.offsetMs;
    if (local >= 0 && local <= timelineDur) {
      const rate = clampPlaybackRate(seg.rate);
      return {
        sourceSec: (seg.trimStartMs + local * rate) / 1000,
        rate,
        inWindow: true,
      };
    }
  }
  const last = segments[segments.length - 1];
  if (!last) {
    return { sourceSec: 0, rate: 1, inWindow: false };
  }
  const rate = clampPlaybackRate(last.rate);
  const lastLocal = recordingSegmentDurationMs(last);
  return {
    sourceSec: (last.trimStartMs + Math.max(0, lastLocal - 1) * rate) / 1000,
    rate,
    inWindow: false,
  };
}

export function drawRecordingSceneFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  W: number,
  H: number,
  assets: SceneAssets,
  opts: DrawOptions = {},
) {
  const background = opts.background ?? DEFAULT_BACKGROUND;
  const customBg = background.kind !== "whiteboard";
  /** Video clip: contain (no stretch). Screen recordings stretch after matte crop. */
  const isVideoClip =
    scene.recordingUseEmbeddedAudio === true && scene.recordingVoiceReplace !== true;
  const cameraFit = isVideoClip ? "contain" : "fill";

  if (!opts.contentOnly) {
    drawSceneBackground(ctx, W, H, opts);
  }

  const padX = customBg ? Math.round(W * CARD_PADDING_FRAC) : 0;
  const padY = customBg ? Math.round(H * CARD_PADDING_FRAC) : 0;
  const innerX = padX;
  const innerY = padY;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;

  ctx.save();
  if (customBg) {
    roundRectPath(ctx, innerX, innerY, innerW, innerH, Math.round(Math.min(W, H) * 0.025));
    ctx.clip();
  }

  // Edge-to-edge inside the orange inset (no white card / black pad).
  const vx = innerX;
  const vy = innerY;
  const vw = customBg ? innerW : W;
  const vh = customBg ? innerH : H;

  const frame = opts.recordingFrame;
  const url = scene.mediaUrl;
  const video = !frame && url ? assets.vid.get(url) : undefined;
  const src: CanvasImageSource | undefined = frame ?? video;
  if (src) {
    const { w: iw, h: ih } = exportSourceSize(src);
    const cam = recordingCameraAt(
      scene.recordingCameraKeyframes,
      opts.elapsedSpeechMs ?? 0,
    );
    const crop =
      !isVideoClip && url
        ? detectAndCacheVideoContentCrop(url, src, iw, ih)
        : { x: 0, y: 0, w: iw, h: ih };
    const local = recordingCameraDrawRects(
      crop.w,
      crop.h,
      vx,
      vy,
      vw,
      vh,
      cam,
      cameraFit,
    );
    if (local) {
      const rects = {
        ...local,
        sx: crop.x + local.sx,
        sy: crop.y + local.sy,
      };
      ctx.drawImage(
        src,
        rects.sx,
        rects.sy,
        rects.sw,
        rects.sh,
        rects.dx,
        rects.dy,
        rects.dw,
        rects.dh,
      );
      const blur = normalizeRecordingBlurRegion(scene.recordingBlurRegion);
      if (blur) {
        drawRecordingBlurRegion(ctx, src, iw, ih, rects, blur);
      }
      const highlights = normalizeRecordingHighlights(scene.recordingHighlights);
      for (const h of highlights) {
        drawRecordingHighlight(
          ctx,
          h,
          iw,
          ih,
          rects,
          opts.elapsedSpeechMs ?? 0,
        );
      }
    } else if (isVideoClip) {
      // Fallback: contain full frame (no stretch).
      const ir = iw / Math.max(1, ih);
      const cr = vw / Math.max(1, vh);
      let dw = vw;
      let dh = vh;
      if (ir > cr) {
        dw = vw;
        dh = vw / ir;
      } else {
        dh = vh;
        dw = vh * ir;
      }
      const dx = vx + (vw - dw) / 2;
      const dy = vy + (vh - dh) / 2;
      ctx.drawImage(src, 0, 0, iw, ih, dx, dy, dw, dh);
    } else {
      // Fallback: stretch cropped content edge-to-edge (no letterbox).
      ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, vx, vy, vw, vh);
    }
  }

  ctx.restore();
}

/** Capture the current video frame into a canvas (stable for export compositing). */
export function snapshotVideoBgFrame(
  video: HTMLVideoElement,
  W: number,
  H: number,
): HTMLCanvasElement {
  const layer = createExportCanvas(W, H) as HTMLCanvasElement;
  layer.width = W;
  layer.height = H;
  const ctx = layer.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  drawContain(ctx, video, 0, 0, W, H, "cover");
  return layer;
}

/** Seek an HTMLVideoElement to a specific time and wait for the frame to be ready. */
export function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  const dur = video.duration && Number.isFinite(video.duration) ? video.duration : t;
  const clamped = Math.max(0, Math.min(Math.max(0, dur - 0.04), t));
  if (Math.abs(video.currentTime - clamped) < 0.02) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeek);
      clearTimeout(fallback);
      resolve();
    };
    const onSeek = () => finish();
    video.addEventListener("seeked", onSeek);
    video.currentTime = clamped;
    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }
    ).requestVideoFrameCallback;
    if (rvfc) {
      rvfc.call(video, finish);
    }
    const fallback = setTimeout(finish, 120);
  });
}

export function drawSceneFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  W: number, H: number,
  assets: SceneAssets,
  opts: DrawOptions = {},
) {
  if (scene.kind === "code") {
    drawCodeSceneFrame(ctx, scene, progress, W, H, opts);
  } else if (scene.kind === "question") {
    drawQuestionSceneFrame(ctx, scene, progress, W, H, opts);
  } else if (scene.kind === "template") {
    drawTemplateSceneFrame(ctx, scene, progress, W, H, opts);
  } else if (scene.kind === "recording") {
    drawRecordingSceneFrame(ctx, scene, progress, W, H, assets, opts);
  } else if (scene.kind === "image") {
    drawImageSceneFrame(ctx, scene, progress, W, H, assets, opts);
  } else if (scene.kind === "stock" && scene.mediaUrl) {
    const v = assets.vid.get(scene.mediaUrl);
    if (v) drawStockFrame(ctx, v, W, H);
    else { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
  } else {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
  }
}

function drawSceneFrameToLayer(
  scene: Scene,
  progress: number,
  W: number,
  H: number,
  assets: SceneAssets,
  opts: DrawOptions,
): HTMLCanvasElement {
  const layer = createExportCanvas(W, H) as HTMLCanvasElement;
  layer.width = W;
  layer.height = H;
  const lctx = layer.getContext("2d")!;
  drawSceneFrame(lctx, scene, progress, W, H, assets, opts);
  return layer;
}

function snapshotToCanvas(
  draw: (ctx: CanvasRenderingContext2D) => void,
  W: number,
  H: number,
): HTMLCanvasElement {
  const layer = createExportCanvas(W, H) as HTMLCanvasElement;
  layer.width = W;
  layer.height = H;
  draw(layer.getContext("2d")!);
  return layer;
}

/** Pre-rendered bg + both scene cards for a slide transition (export caches this). */
export interface SlideTransitionCache {
  from: number;
  to: number;
  background: HTMLCanvasElement;
  fromLayer: HTMLCanvasElement;
  toLayer: HTMLCanvasElement;
}

/** Snapshot bg + both card layers once; reuse while sliding (matches preview compositing). */
export function createSlideTransitionCache(
  scenes: Scene[],
  from: number,
  to: number,
  W: number,
  H: number,
  assets: SceneAssets,
  opts: DrawOptions = {},
  fromDrawOpts: DrawOptions = opts,
): SlideTransitionCache {
  return {
    from,
    to,
    background: snapshotToCanvas((ctx) => drawSceneBackground(ctx, W, H, opts), W, H),
    fromLayer: drawSceneFrameToLayer(scenes[from]!, 1, W, H, assets, {
      ...fromDrawOpts,
      contentOnly: true,
      ...(scenes[from]!.kind === "recording"
        ? { elapsedSpeechMs: revealSpeechDurationMs(scenes[from]!) }
        : {}),
    }),
    toLayer: drawSceneFrameToLayer(scenes[to]!, 0, W, H, assets, {
      ...opts,
      contentOnly: true,
      ...(scenes[to]!.kind === "recording" ? { elapsedSpeechMs: 0 } : {}),
    }),
  };
}

/** Blit cached layers with integer pixel offsets to avoid canvas subpixel shimmer. */
export function drawCachedSlideTransition(
  ctx: CanvasRenderingContext2D,
  cache: SlideTransitionCache,
  slideT: number,
  W: number,
  H: number,
): void {
  const slide = slideOffset(slideT);
  const fromX = Math.round(-slide * W);
  const toX = Math.round((1 - slide) * W);
  ctx.drawImage(cache.background, 0, 0, W, H);
  ctx.drawImage(cache.fromLayer, fromX, 0, W, H);
  ctx.drawImage(cache.toLayer, toX, 0, W, H);
}

/** Slide two scenes left: fixed outer bg, only card/content layers move. */
export function drawSlideTransition(
  ctx: CanvasRenderingContext2D,
  scenes: Scene[],
  from: number,
  to: number,
  slideT: number,
  W: number,
  H: number,
  assets: SceneAssets,
  opts: DrawOptions = {},
  fromDrawOpts: DrawOptions = opts,
): void {
  const cache = createSlideTransitionCache(
    scenes,
    from,
    to,
    W,
    H,
    assets,
    opts,
    fromDrawOpts,
  );
  drawCachedSlideTransition(ctx, cache, slideT, W, H);
}

/** Draw the correct frame for an absolute master-timeline position. */
export function drawMasterVisualFrame(
  ctx: CanvasRenderingContext2D,
  scenes: Scene[],
  tMs: number,
  W: number,
  H: number,
  assets: SceneAssets,
  opts: DrawOptions = {},
) {
  const vis = masterVisualAt(tMs, scenes);
  if (!vis) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    return;
  }

  if (vis.phase === "transition" && vis.fromIndex !== vis.toIndex) {
    const fromScene = scenes[vis.fromIndex];
    const fromOpts = {
      ...opts,
      questionPhase:
        fromScene.kind === "question" ? ("mark" as const) : opts.questionPhase,
      markHoldElapsedMs:
        fromScene.kind === "question"
          ? questionMarkCountdownMs(fromScene)
          : opts.markHoldElapsedMs,
    };
    drawSlideTransition(
      ctx,
      scenes,
      vis.fromIndex,
      vis.toIndex,
      vis.slideT,
      W,
      H,
      assets,
      opts,
      fromOpts,
    );
    return;
  }

  const activeScene = scenes[vis.sceneIndex];
  const sceneStart = activeScene.startMs ?? 0;
  const speechDur = revealSpeechDurationMs(activeScene);
  let drawOpts = opts;
  let drawProgress = vis.progress;
  if (activeScene.kind === "question") {
    const elapsed = Math.max(0, tMs - sceneStart);
    const timeline = questionTimelineAt(elapsed, activeScene, speechDur);
    drawOpts = {
      ...opts,
      questionPhase: timeline.phase,
      markHoldElapsedMs: timeline.markElapsedMs,
    };
    drawProgress = timeline.questionProgress;
  } else if (
    activeScene.kind === "template" &&
    activeScene.templateKind === "countdown"
  ) {
    drawProgress = templateCountdownProgress(vis.elapsedSpeechMs, activeScene.templateCountdownSec);
  } else if (activeScene.kind === "recording") {
    drawOpts = { ...opts, elapsedSpeechMs: vis.elapsedSpeechMs };
  }
  drawSceneFrame(ctx, activeScene, drawProgress, W, H, assets, drawOpts);
}

export function masterTimelineDurationMs(scenes: Scene[]): number {
  if (scenes.length === 0) return 0;
  const last = scenes[scenes.length - 1];
  if (!last) return 0;
  const start = last.startMs ?? 0;
  const computed = start + revealSpeechDurationMs(last);
  if (last.kind === "template" && last.templateKind === "countdown") {
    return computed;
  }
  if (last.endMs != null) return Math.max(last.endMs, computed);
  return computed;
}

