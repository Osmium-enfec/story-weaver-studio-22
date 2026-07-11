// Pure "draw one frame of scene X at time T" helpers.
// Extracted from render-video.ts so both live playback export and the
// ffmpeg rasterizer can share the same drawing code.

import type { Scene } from "@/components/VideoPlayer";
import {
  CARD_PADDING_FRAC,
  DEFAULT_BACKGROUND,
  backgroundToCanvasFill,
  type SceneBackground,
} from "./scene-background";
import { layoutFor } from "./scene-layouts";

export interface DrawOptions {
  background?: SceneBackground;
  transparent?: Map<string, HTMLImageElement>;
  /** For background.kind === "video". Caller must seek/advance the element
   *  before calling drawSceneFrame; we just draw its current frame. */
  videoBg?: HTMLVideoElement;
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
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    v.onloadeddata = () => resolve(v);
    v.onerror = reject;
  });
}

export interface SceneAssets {
  bg: Map<string, HTMLImageElement>;
  el: Map<string, HTMLImageElement>;
  vid: Map<string, HTMLVideoElement>;
  cov: Map<string, HTMLImageElement>;
}

export async function preloadSceneAssets(scenes: Scene[]): Promise<SceneAssets> {
  const bg = new Map<string, HTMLImageElement>();
  const el = new Map<string, HTMLImageElement>();
  const vid = new Map<string, HTMLVideoElement>();
  const cov = new Map<string, HTMLImageElement>();

  const jobs: Promise<void>[] = [];
  for (const s of scenes) {
    if (s.kind === "image") {
      if (s.backgroundUrl && !bg.has(s.backgroundUrl)) {
        const url = s.backgroundUrl;
        jobs.push(
          loadImage(url).then((img) => { bg.set(url, img); }).catch(() => {}),
        );
      }
      for (const e of s.elements ?? []) {
        if (!el.has(e.mediaUrl)) {
          const url = e.mediaUrl;
          jobs.push(
            loadImage(url).then((img) => { el.set(url, img); }).catch(() => {}),
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
    } else if (s.kind === "stock" && s.mediaUrl) {
      const url = s.mediaUrl;
      if (!vid.has(url)) {
        jobs.push(
          loadVideo(url).then((v) => { vid.set(url, v); }).catch(() => {}),
        );
      }
    }
  }
  await Promise.all(jobs);
  return { bg, el, vid, cov };
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLVideoElement,
  x: number, y: number, w: number, h: number,
  mode: "cover" | "contain" = "cover",
) {
  const iw = "videoWidth" in img ? img.videoWidth : img.naturalWidth;
  const ih = "videoHeight" in img ? img.videoHeight : img.naturalHeight;
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

  // Outer canvas: user-picked color / gradient / video, or plain white.
  if (background.kind === "video" && opts.videoBg) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    drawContain(ctx, opts.videoBg, 0, 0, W, H, "cover");
  } else if (customBg) {
    backgroundToCanvasFill(ctx, background, W, H);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
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

  const bg = scene.backgroundUrl ? assets.bg.get(scene.backgroundUrl) ?? null : null;
  if (bg) {
    const t = progress;
    let scale = 1.02;
    let tx = 0;
    if (scene.animation === "kenburns-in") scale = 1 + 0.08 * t;
    else if (scene.animation === "kenburns-out") scale = 1.08 - 0.08 * t;
    else if (scene.animation === "slide-left") { scale = 1.04; tx = (0.5 - t) * 20; }
    ctx.save();
    ctx.translate(innerX + innerW / 2 + tx, innerY + innerH / 2);
    ctx.scale(scale, scale);
    // Match live player: object-contain over a white card background.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(-innerW / 2, -innerH / 2, innerW, innerH);
    drawContain(ctx, bg, -innerW / 2, -innerH / 2, innerW, innerH, "contain");
    ctx.restore();
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

    const boxW = innerW * pos.w;
    const boxH = pos.h != null ? innerH * pos.h : boxW;
    const iw = img.naturalWidth || 1;
    const ih = img.naturalHeight || 1;
    const ratio = ih / iw;
    // Fit-contain into box
    const boxRatio = boxH / boxW;
    let targetW: number, targetH: number;
    if (ratio > boxRatio) { targetH = boxH; targetW = boxH / ratio; }
    else { targetW = boxW; targetH = boxW * ratio; }
    const cx = innerX + pos.x * innerW;
    const cy = innerY + pos.y * innerH;

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

    if (el.label) {
      const labelSize = Math.max(18, Math.round(targetW * 0.09));
      ctx.save();
      ctx.globalAlpha = eased;
      ctx.font = `700 ${labelSize}px Caveat, Kalam, cursive`;
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
) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const pad = Math.round(W * 0.06);
  const boxX = pad, boxY = pad;
  const boxW = W - pad * 2, boxH = H - pad * 2;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 2;
  const r = 16;
  ctx.beginPath();
  ctx.moveTo(boxX + r, boxY);
  ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r);
  ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r);
  ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r);
  ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const code = scene.code ?? "";
  const chars = Math.floor(code.length * Math.min(1, progress * 1.4));
  const shown = code.slice(0, chars);
  const fontSize = Math.round(H * 0.028);
  ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.fillStyle = "#1e293b";
  ctx.textBaseline = "top";
  shown.split("\n").forEach((line, i) => {
    ctx.fillText(line, boxX + 24, boxY + 24 + i * (fontSize * 1.5));
  });
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

/** Seek an HTMLVideoElement to a specific time and wait for the frame to be ready. */
export function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeek = () => { video.removeEventListener("seeked", onSeek); resolve(); };
    video.addEventListener("seeked", onSeek);
    video.currentTime = Math.max(0, Math.min(video.duration || t, t));
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
    drawCodeSceneFrame(ctx, scene, progress, W, H);
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

