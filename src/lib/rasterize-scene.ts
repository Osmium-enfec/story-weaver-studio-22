// Pure "draw one frame of scene X at time T" helpers.
// Extracted from render-video.ts so both live playback export and the
// ffmpeg rasterizer can share the same drawing code.

import type { Scene } from "@/components/VideoPlayer";

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
}

export async function preloadSceneAssets(scenes: Scene[]): Promise<SceneAssets> {
  const bg = new Map<string, HTMLImageElement>();
  const el = new Map<string, HTMLImageElement>();
  const vid = new Map<string, HTMLVideoElement>();

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
  return { bg, el, vid };
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
) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  const bg = scene.backgroundUrl ? assets.bg.get(scene.backgroundUrl) ?? null : null;
  if (bg) {
    const t = progress;
    let scale = 1.02;
    let tx = 0;
    if (scene.animation === "kenburns-in") scale = 1 + 0.08 * t;
    else if (scene.animation === "kenburns-out") scale = 1.08 - 0.08 * t;
    else if (scene.animation === "slide-left") { scale = 1.04; tx = (0.5 - t) * 20; }
    ctx.save();
    ctx.translate(W / 2 + tx, H / 2);
    ctx.scale(scale, scale);
    drawContain(ctx, bg, -W / 2, -H / 2, W, H, "cover");
    ctx.restore();
  }

  const elements = (scene.elements ?? [])
    .map((e) => { const img = assets.el.get(e.mediaUrl); return img ? { img, el: e } : null; })
    .filter((x): x is { img: HTMLImageElement; el: NonNullable<Scene["elements"]>[number] } => !!x);
  const single = elements.length === 1;

  for (const { img, el } of elements) {
    if (progress < el.appearAt) continue;
    const revealWindow = Math.max(0.02, 450 / Math.max(1, scene.durationMs));
    const p = Math.min(1, (progress - el.appearAt) / revealWindow);
    const eased = easeOutCubic(p);

    const wFrac = single ? Math.max(0.6, el.w * 2.2) : el.w;
    const targetW = W * wFrac;
    const naturalRatio = img.naturalHeight / Math.max(1, img.naturalWidth);
    const targetH = targetW * naturalRatio;
    const cx = single ? W / 2 : el.x * W;
    const cy = single ? H / 2 : el.y * H;

    let scale = 1, dx = 0, dy = 0;
    switch (el.anim) {
      case "pop": scale = 0.6 + 0.4 * eased; break;
      case "slide-up": dy = (1 - eased) * 40; break;
      case "slide-left": dx = (1 - eased) * -60; break;
      case "slide-right": dx = (1 - eased) * 60; break;
    }

    ctx.save();
    ctx.globalAlpha = eased;
    ctx.globalCompositeOperation = "multiply";
    ctx.translate(cx + dx, cy + dy);
    ctx.scale(scale, scale);
    ctx.drawImage(img, -targetW / 2, -targetH / 2, targetW, targetH);
    ctx.restore();
  }
}

export function drawCodeSceneFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  W: number, H: number,
) {
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  const pad = Math.round(W * 0.06);
  const boxX = pad, boxY = pad;
  const boxW = W - pad * 2, boxH = H - pad * 2;
  ctx.fillStyle = "#1e293b";
  const r = 16;
  ctx.beginPath();
  ctx.moveTo(boxX + r, boxY);
  ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r);
  ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r);
  ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r);
  ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r);
  ctx.closePath();
  ctx.fill();

  const code = scene.code ?? "";
  const chars = Math.floor(code.length * Math.min(1, progress * 1.4));
  const shown = code.slice(0, chars);
  const fontSize = Math.round(H * 0.028);
  ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.fillStyle = "#e2e8f0";
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
) {
  if (scene.kind === "code") {
    drawCodeSceneFrame(ctx, scene, progress, W, H);
  } else if (scene.kind === "image") {
    drawImageSceneFrame(ctx, scene, progress, W, H, assets);
  } else if (scene.kind === "stock" && scene.mediaUrl) {
    const v = assets.vid.get(scene.mediaUrl);
    if (v) drawStockFrame(ctx, v, W, H);
    else { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
  } else {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
  }
}
