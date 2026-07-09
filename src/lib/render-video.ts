import type { Scene } from "@/components/VideoPlayer";
import fixWebmDuration from "fix-webm-duration";

export type RenderQuality = "preview" | "hd";

const INTER_SCENE_GAP_MS = 550;
const PLAYBACK_RATE = 0.95;

const QUALITY_PRESETS: Record<RenderQuality, { w: number; h: number; fps: number; bps: number }> = {
  preview: { w: 1280, h: 720, fps: 30, bps: 6_000_000 },
  hd: { w: 1920, h: 1080, fps: 60, bps: 14_000_000 },
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
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

function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLVideoElement,
  x: number,
  y: number,
  w: number,
  h: number,
  mode: "cover" | "contain" = "cover",
) {
  const iw = "videoWidth" in img ? img.videoWidth : img.naturalWidth;
  const ih = "videoHeight" in img ? img.videoHeight : img.naturalHeight;
  if (!iw || !ih) return;
  const ir = iw / ih;
  const cr = w / h;
  let dw = w;
  let dh = h;
  if ((mode === "cover") === ir > cr) {
    dh = h;
    dw = h * ir;
  } else {
    dw = w;
    dh = w / ir;
  }
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function drawSubtitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  W: number,
  H: number,
) {
  const pad = Math.round(H * 0.05);
  const fontSize = Math.round(H * 0.038);
  ctx.save();
  const grad = ctx.createLinearGradient(0, H * 0.75, 0, H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.7)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, H * 0.7, W, H * 0.3);
  ctx.fillStyle = "#fff";
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 8;
  ctx.fillText(text, W / 2, H - pad, W * 0.9);
  ctx.restore();
}

async function drawImageScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  W: number,
  H: number,
  bg: HTMLImageElement | null,
  elements: { img: HTMLImageElement; el: NonNullable<Scene["elements"]>[number] }[],
) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  if (bg) {
    const t = progress;
    let scale = 1.02;
    let tx = 0;
    if (scene.animation === "kenburns-in") scale = 1 + 0.08 * t;
    else if (scene.animation === "kenburns-out") scale = 1.08 - 0.08 * t;
    else if (scene.animation === "slide-left") {
      scale = 1.04;
      tx = (0.5 - t) * 20;
    }
    ctx.save();
    ctx.translate(W / 2 + tx, H / 2);
    ctx.scale(scale, scale);
    drawContain(ctx, bg, -W / 2, -H / 2, W, H, "cover");
    ctx.restore();
  }

  const single = elements.length === 1;
  for (const { img, el } of elements) {
    if (progress < el.appearAt) continue;
    const revealWindow = Math.max(0.02, 450 / Math.max(1, scene.durationMs));
    const p = Math.min(1, (progress - el.appearAt) / revealWindow);
    const eased = easeOutCubic(p);

    // Single element scenes: fill much more of the canvas.
    const wFrac = single ? Math.max(0.6, el.w * 2.2) : el.w;
    const targetW = W * wFrac;
    const naturalRatio = img.naturalHeight / Math.max(1, img.naturalWidth);
    const targetH = targetW * naturalRatio;

    const cx = single ? W / 2 : el.x * W;
    const cy = single ? H / 2 : el.y * H;

    let scale = 1;
    let dx = 0;
    let dy = 0;
    switch (el.anim) {
      case "pop":
        scale = 0.6 + 0.4 * eased;
        break;
      case "slide-up":
        dy = (1 - eased) * 40;
        break;
      case "slide-left":
        dx = (1 - eased) * -60;
        break;
      case "slide-right":
        dx = (1 - eased) * 60;
        break;
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

function drawCodeScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  progress: number,
  W: number,
  H: number,
) {
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  const pad = Math.round(W * 0.06);
  const boxX = pad;
  const boxY = pad;
  const boxW = W - pad * 2;
  const boxH = H - pad * 2;
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
  const lines = shown.split("\n");
  const lineH = fontSize * 1.5;
  lines.forEach((line, i) => {
    ctx.fillText(line, boxX + 24, boxY + 24 + i * lineH);
  });
}

export async function renderVideo(
  scenes: Scene[],
  quality: RenderQuality,
  onProgress?: (frac: number) => void,
): Promise<Blob> {
  const { w: W, h: H, fps, bps } = QUALITY_PRESETS[quality];
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  // Preload all assets up-front so recording is smooth.
  const bgCache = new Map<string, HTMLImageElement>();
  const elCache = new Map<string, HTMLImageElement>();
  const vidCache = new Map<string, HTMLVideoElement>();
  for (const s of scenes) {
    if (s.kind === "image") {
      if (s.backgroundUrl && !bgCache.has(s.backgroundUrl)) {
        try {
          bgCache.set(s.backgroundUrl, await loadImage(s.backgroundUrl));
        } catch {}
      }
      for (const el of s.elements ?? []) {
        if (!elCache.has(el.mediaUrl)) {
          try {
            elCache.set(el.mediaUrl, await loadImage(el.mediaUrl));
          } catch {}
        }
      }
    } else if (s.kind === "stock" && s.mediaUrl) {
      if (!vidCache.has(s.mediaUrl)) {
        try {
          vidCache.set(s.mediaUrl, await loadVideo(s.mediaUrl));
        } catch {}
      }
    }
  }

  // Audio pipeline
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  const audioBuffers = new Map<string, AudioBuffer>();
  for (const s of scenes) {
    if (audioBuffers.has(s.audioUrl)) continue;
    try {
      const arr = await fetch(s.audioUrl).then((r) => r.arrayBuffer());
      audioBuffers.set(s.audioUrl, await audioCtx.decodeAudioData(arr));
    } catch {}
  }

  // Recorder
  const videoStream = canvas.captureStream(fps);
  const stream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: bps,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
  });
  recorder.start();

  const totalDuration = scenes.reduce(
    (a, s) => a + s.durationMs / PLAYBACK_RATE + INTER_SCENE_GAP_MS,
    0,
  );
  let elapsed = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const durMs = scene.durationMs / PLAYBACK_RATE;
    const startAt = audioCtx.currentTime;
    const buf = audioBuffers.get(scene.audioUrl);
    if (buf) {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = PLAYBACK_RATE;
      src.connect(dest);
      src.start(startAt);
    }

    const video = scene.kind === "stock" ? vidCache.get(scene.mediaUrl!) : null;
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {});
    }

    const startPerf = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = performance.now() - startPerf;
        const progress = Math.min(1, now / durMs);
        if (scene.kind === "image") {
          const bg = scene.backgroundUrl ? bgCache.get(scene.backgroundUrl) ?? null : null;
          const els = (scene.elements ?? [])
            .map((el) => {
              const img = elCache.get(el.mediaUrl);
              return img ? { img, el } : null;
            })
            .filter((x): x is { img: HTMLImageElement; el: any } => !!x);
          drawImageScene(ctx, scene, progress, W, H, bg, els);
        } else if (scene.kind === "code") {
          drawCodeScene(ctx, scene, progress, W, H);
        } else if (video) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, W, H);
          drawContain(ctx, video, 0, 0, W, H, "cover");
        } else {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, W, H);
        }
        drawSubtitle(ctx, scene.subtitle, W, H);
        onProgress?.(Math.min(1, (elapsed + now) / totalDuration));
        if (progress < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

    if (video) video.pause();
    elapsed += durMs;

    if (i < scenes.length - 1) {
      // Silent gap between scenes; keep the last frame visible.
      await new Promise((r) => setTimeout(r, INTER_SCENE_GAP_MS));
      elapsed += INTER_SCENE_GAP_MS;
      onProgress?.(Math.min(1, elapsed / totalDuration));
    }
  }

  recorder.stop();
  const blob = await stopped;
  audioCtx.close().catch(() => {});
  return blob;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
