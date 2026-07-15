import type { Scene } from "@/components/VideoPlayer";
import { canvasFont } from "./scene-font";
import fixWebmDuration from "fix-webm-duration";
import { speechProgressInScene } from "./reveal-schedule";
import { drawCodeEditor } from "./code-scene-canvas";
import { drawQuestionSceneFrame } from "./rasterize-scene";
import {
  questionMarkGapMs,
  questionMarkCountdownMs,
  questionPostSpeechVisualMs,
  QUESTION_POST_COUNTDOWN_GAP_MS,
} from "./question-scene-layout";
import { DEFAULT_BACKGROUND, backgroundToCanvasFill, CARD_PADDING_FRAC } from "./scene-background";

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
  ctx.font = canvasFont(600, fontSize);
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
  const background = DEFAULT_BACKGROUND;
  const customBg = background.kind !== "whiteboard";
  if (customBg) backgroundToCanvasFill(ctx, background, W, H);
  else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
  }

  const padX = customBg ? Math.round(W * CARD_PADDING_FRAC) : Math.round(W * 0.06);
  const padY = customBg ? Math.round(H * CARD_PADDING_FRAC) : Math.round(H * 0.06);
  const innerX = padX;
  const innerY = padY;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const editorPad = customBg
    ? Math.round(Math.min(innerW, innerH) * 0.05)
    : Math.round(Math.min(W, H) * 0.06);

  drawCodeEditor(
    ctx,
    scene,
    progress,
    innerX + editorPad,
    innerY + editorPad,
    (customBg ? innerW : W) - editorPad * 2,
    (customBg ? innerH : H) - editorPad * 2,
  );
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

  // Audio pipeline. If scenes share a masterAudioUrl, play that ONE track
  // continuously; scenes are just visual windows on it (no inter-scene silent
  // gaps, and audio can never get cut off mid-word).
  const masterAudioUrl = scenes[0]?.masterAudioUrl;
  const masterMode = !!masterAudioUrl && scenes.every((s) => s.masterAudioUrl === masterAudioUrl);
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  const audioBuffers = new Map<string, AudioBuffer>();
  if (masterMode) {
    try {
      const arr = await fetch(masterAudioUrl!).then((r) => r.arrayBuffer());
      audioBuffers.set(masterAudioUrl!, await audioCtx.decodeAudioData(arr));
    } catch {}
  } else {
    for (const s of scenes) {
      if (audioBuffers.has(s.audioUrl)) continue;
      try {
        const arr = await fetch(s.audioUrl).then((r) => r.arrayBuffer());
        audioBuffers.set(s.audioUrl, await audioCtx.decodeAudioData(arr));
      } catch {}
      if (s.kind === "question" && s.questionMarkAudioUrl && !audioBuffers.has(s.questionMarkAudioUrl)) {
        try {
          const arr = await fetch(s.questionMarkAudioUrl).then((r) => r.arrayBuffer());
          audioBuffers.set(s.questionMarkAudioUrl, await audioCtx.decodeAudioData(arr));
        } catch {}
      }
    }
  }

  // Recorder — request frames manually so background-tab throttling can't stall us.
  const videoTrack = (canvas as HTMLCanvasElement & {
    captureStream: (fps?: number) => MediaStream;
  }).captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const stream = new MediaStream([videoTrack, ...dest.stream.getAudioTracks()]);
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
  recorder.start(1000);

  // Per-scene visual durations
  const sceneDurations = scenes.map((s, i) => {
    if (masterMode) {
      const start = s.startMs ?? 0;
      const end = s.endMs ?? start + (s.durationMs || 4000);
      return Math.max(300, end - start);
    }
    return s.durationMs / PLAYBACK_RATE;
  });
  const totalDuration = masterMode
    ? sceneDurations.reduce((a, b) => a + b, 0)
    : scenes.reduce((acc, s, i) => {
        const d = s.durationMs / PLAYBACK_RATE;
        const markHold =
          s.kind === "question" ? questionPostSpeechVisualMs(s) / PLAYBACK_RATE : 0;
        const gap = i < scenes.length - 1 ? INTER_SCENE_GAP_MS : 0;
        return acc + d + markHold + gap;
      }, 0);
  const recordStart = performance.now();
  let elapsed = 0;
  const frameInterval = 1000 / fps;

  const pushFrame = () => {
    if (typeof videoTrack.requestFrame === "function") videoTrack.requestFrame();
  };

  const runPhase = async (
    durMs: number,
    draw: (progress: number) => void,
  ) => {
    const start = performance.now();
    let nextFrame = start;
    while (true) {
      const now = performance.now();
      const p = Math.min(1, (now - start) / durMs);
      draw(p);
      pushFrame();
      if (p >= 1) break;
      nextFrame += frameInterval;
      const wait = Math.max(0, nextFrame - performance.now());
      await new Promise((r) => setTimeout(r, wait));
    }
  };

  // Start master audio ONCE at t=0.
  if (masterMode) {
    const buf = audioBuffers.get(masterAudioUrl!);
    if (buf) {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start(audioCtx.currentTime);
    }
  }

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const durMs = sceneDurations[i];
    if (!masterMode) {
      const buf = audioBuffers.get(scene.audioUrl);
      if (buf) {
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = PLAYBACK_RATE;
        src.connect(dest);
        src.start(audioCtx.currentTime);
      }
    }

    const video = scene.kind === "stock" ? vidCache.get(scene.mediaUrl!) : null;
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {});
    }

    await runPhase(durMs, (windowProgress) => {
      const progress = masterMode
        ? speechProgressInScene(windowProgress * durMs, scene)
        : windowProgress;
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
      } else if (scene.kind === "question") {
        drawQuestionSceneFrame(ctx, scene, progress, W, H, { questionPhase: "question" });
      } else if (video) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        drawContain(ctx, video, 0, 0, W, H, "cover");
      } else {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, W, H);
      }
      onProgress?.(Math.min(1, (elapsed + progress * durMs) / totalDuration));
    });

    if (video) video.pause();
    elapsed += durMs;

    if (!masterMode && scene.kind === "question") {
      const gapMs = questionMarkGapMs(scene);
      await runPhase(gapMs / PLAYBACK_RATE, () => {
        drawQuestionSceneFrame(ctx, scene, 1, W, H, { questionPhase: "mark-gap" });
        onProgress?.(Math.min(1, elapsed / totalDuration));
      });
      elapsed += gapMs / PLAYBACK_RATE;

      const countdownMs = questionMarkCountdownMs(scene);
      const markBuf = scene.questionMarkAudioUrl
        ? audioBuffers.get(scene.questionMarkAudioUrl)
        : null;
      if (markBuf) {
        const src = audioCtx.createBufferSource();
        src.buffer = markBuf;
        src.connect(dest);
        src.start(audioCtx.currentTime);
      }
      await runPhase(countdownMs / PLAYBACK_RATE, (holdProgress) => {
        const markElapsed = holdProgress * countdownMs;
        drawQuestionSceneFrame(ctx, scene, 1, W, H, {
          questionPhase: "mark",
          markHoldElapsedMs: markElapsed,
        });
        onProgress?.(Math.min(1, elapsed / totalDuration));
      });
      elapsed += countdownMs / PLAYBACK_RATE;

      const postHoldMs = QUESTION_POST_COUNTDOWN_GAP_MS;
      await runPhase(postHoldMs / PLAYBACK_RATE, () => {
        drawQuestionSceneFrame(ctx, scene, 1, W, H, {
          questionPhase: "mark",
          markHoldElapsedMs: countdownMs,
        });
        onProgress?.(Math.min(1, elapsed / totalDuration));
      });
      elapsed += postHoldMs / PLAYBACK_RATE;
    }

    if (!masterMode && i < scenes.length - 1) {
      // Silent gap ONLY in per-scene mode. Master mode has continuous audio.
      await runPhase(INTER_SCENE_GAP_MS, () => {});
      elapsed += INTER_SCENE_GAP_MS;
      onProgress?.(Math.min(1, elapsed / totalDuration));
    }
  }

  recorder.stop();
  const rawBlob = await stopped;
  const actualDurationMs = performance.now() - recordStart;
  audioCtx.close().catch(() => {});

  // MediaRecorder writes WebM without a Duration element, which makes the file
  // unseekable (appears stuck; clicking a scrub jumps to the end). Patch it.
  try {
    const fixed = await fixWebmDuration(rawBlob, actualDurationMs, { logger: false });
    return fixed;
  } catch {
    return rawBlob;
  }
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
