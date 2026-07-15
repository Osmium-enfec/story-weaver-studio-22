// Hybrid MP4 exporter: rasterize via canvas → PNG frames → ffmpeg H.264 → mux audio.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { Scene } from "@/components/VideoPlayer";
import {
  preloadSceneAssets,
  drawMasterVisualFrame,
  drawSceneFrame,
  seekVideo,
  loadVideo,
} from "./rasterize-scene";
import { DEFAULT_BACKGROUND, type SceneBackground } from "./scene-background";
import { preloadTransparent } from "./remove-white-bg";
import { revealSpeechDurationMs } from "./reveal-schedule";
import {
  sceneGapMs,
  sceneHoldMs,
  sceneTransitionMs,
  slideOffset,
} from "./scene-transition";
import {
  questionPostSpeechAt,
  questionMarkCountdownMs,
  questionPreQuestionMs,
  questionTimelineAt,
} from "./question-scene-layout";
import {
  exportNeedsAudioMix,
  mixExportAudio,
} from "./export-audio-mix";
import type { PartBgmConfig } from "./part-bgm";

export type ExportQuality = "preview" | "hd";
export type StageProgress = (stage: string, ratio: number) => void;

const PRESETS: Record<
  ExportQuality,
  { w: number; h: number; fps: number; preset: string; crf: number }
> = {
  preview: { w: 1280, h: 720, fps: 30, preset: "ultrafast", crf: 26 },
  hd: { w: 1920, h: 1080, fps: 60, preset: "veryfast", crf: 20 },
};

let ffmpegSingleton: FFmpeg | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegSingleton) return ffmpegSingleton;
  const ffmpeg = new FFmpeg();
  const [coreJsUrl, coreWasmUrl] = await Promise.all([
    import("@ffmpeg/core?url").then((m) => m.default),
    import("@ffmpeg/core/wasm?url").then((m) => m.default),
  ]);
  await ffmpeg.load({
    coreURL: await toBlobURL(coreJsUrl, "text/javascript"),
    wasmURL: await toBlobURL(coreWasmUrl, "application/wasm"),
  });
  ffmpegSingleton = ffmpeg;
  return ffmpeg;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("canvas.toBlob returned null"));
      const buf = await blob.arrayBuffer();
      resolve(new Uint8Array(buf));
    }, "image/png");
  });
}

function masterTimelineDurationMs(scenes: Scene[]): number {
  if (scenes.length === 0) return 0;
  const last = scenes[scenes.length - 1];
  if (last.endMs != null) return last.endMs;
  const start = last.startMs ?? 0;
  return start + revealSpeechDurationMs(last);
}

function perSceneTimelineDurationMs(scenes: Scene[]): number {
  return scenes.reduce((acc, s, i) => {
    const speech = revealSpeechDurationMs(s);
    const pre = s.kind === "question" ? questionPreQuestionMs(s) : 0;
    const tail = i < scenes.length - 1 ? sceneGapMs(s) : 0;
    return acc + pre + speech + tail;
  }, 0);
}

function drawSlidePair(
  ctx: CanvasRenderingContext2D,
  scenes: Scene[],
  from: number,
  to: number,
  t: number,
  W: number,
  H: number,
  assets: Awaited<ReturnType<typeof preloadSceneAssets>>,
  drawOpts: Parameters<typeof drawSceneFrame>[6],
  fromDrawOpts: Parameters<typeof drawSceneFrame>[6] = drawOpts,
) {
  const slide = slideOffset(t);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(-slide * W, 0);
  drawSceneFrame(ctx, scenes[from], 1, W, H, assets, fromDrawOpts);
  ctx.restore();
  ctx.save();
  ctx.translate((1 - slide) * W, 0);
  drawSceneFrame(ctx, scenes[to], 0, W, H, assets, drawOpts);
  ctx.restore();
}

export async function exportToMp4(
  scenes: Scene[],
  masterAudioUrl: string | undefined,
  quality: ExportQuality,
  onProgress: StageProgress,
  background: SceneBackground = DEFAULT_BACKGROUND,
  bgm?: PartBgmConfig | null,
): Promise<Blob> {
  const { w: W, h: H, fps, preset, crf } = PRESETS[quality];
  const masterMode = !!masterAudioUrl && scenes.every((s) => s.masterAudioUrl === masterAudioUrl);

  onProgress("loading ffmpeg…", 0);
  const ffmpeg = await getFFmpeg();

  onProgress("loading assets…", 0.02);
  const assets = await preloadSceneAssets(scenes);
  const transparentMap = background.kind === "whiteboard"
    ? new Map<string, string>()
    : await preloadTransparent(
        Array.from(new Set(scenes.flatMap((s) => (s.elements ?? []).map((e) => e.mediaUrl)))),
      );
  const transparentImgs = new Map<string, HTMLImageElement>();
  await Promise.all(
    Array.from(transparentMap.entries()).map(async ([orig, url]) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const done = new Promise<void>((res) => {
        img.onload = () => res();
        img.onerror = () => res();
      });
      img.src = url;
      await done;
      transparentImgs.set(orig, img);
    }),
  );

  const videoBgEl =
    background.kind === "video" ? await loadVideo(background.url).catch(() => null) : null;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;

  const drawOpts = {
    background,
    transparent: transparentImgs,
    videoBg: videoBgEl ?? undefined,
  };

  const totalMs = masterMode
    ? masterTimelineDurationMs(scenes)
    : perSceneTimelineDurationMs(scenes);
  const totalFrames = Math.max(1, Math.ceil((totalMs / 1000) * fps));
  const totalUnits = totalFrames + 2;
  let unitsDone = 0;
  const frac = () => Math.min(0.999, unitsDone / totalUnits);
  const tick = (n = 1) => { unitsDone += n; return frac(); };

  for (let f = 0; f < totalFrames; f++) {
    const tMs = (f / fps) * 1000;

    if (masterMode) {
      if (videoBgEl) {
        const dur = videoBgEl.duration || 1;
        try { await seekVideo(videoBgEl, (tMs / 1000) % dur); } catch { /* ignore */ }
      }
      drawMasterVisualFrame(ctx, scenes, tMs, W, H, assets, drawOpts);
    } else {
      let acc = 0;
      let drawn = false;
      for (let i = 0; i < scenes.length; i++) {
        const speech = revealSpeechDurationMs(scenes[i]);
        const pre = scenes[i].kind === "question" ? questionPreQuestionMs(scenes[i]) : 0;
        const gap = i < scenes.length - 1 ? sceneGapMs(scenes[i]) : 0;
        const holdMs = sceneHoldMs(scenes[i]);
        const transitionMs = sceneTransitionMs(scenes[i]);
        const block = pre + speech + gap;
        if (tMs < acc + block) {
          const local = tMs - acc;
          if (local < pre + speech) {
            if (scenes[i].kind === "question") {
              const timeline = questionTimelineAt(local, scenes[i], speech);
              drawSceneFrame(ctx, scenes[i], timeline.questionProgress, W, H, assets, {
                ...drawOpts,
                questionPhase: timeline.phase,
                markHoldElapsedMs: timeline.markElapsedMs,
              });
            } else {
              const p = speech <= 1 ? 0 : Math.max(0, local - pre) / speech;
              drawSceneFrame(ctx, scenes[i], Math.min(1, p), W, H, assets, drawOpts);
            }
          } else if (i < scenes.length - 1) {
            const gapLocal = local - pre - speech;
            if (gapLocal < holdMs) {
              if (scenes[i].kind === "question") {
                const post = questionPostSpeechAt(gapLocal, scenes[i]);
                const qPhase =
                  post.phase === "gap" ? ("mark-gap" as const) : ("mark" as const);
                drawSceneFrame(ctx, scenes[i], 1, W, H, assets, {
                  ...drawOpts,
                  questionPhase: qPhase,
                  markHoldElapsedMs: post.markElapsedMs,
                });
              } else {
                drawSceneFrame(ctx, scenes[i], 1, W, H, assets, drawOpts);
              }
            } else {
              const slideT = Math.min(
                1,
                (gapLocal - holdMs) / transitionMs,
              );
              const fromOpts =
                scenes[i].kind === "question"
                  ? {
                      ...drawOpts,
                      questionPhase: "mark" as const,
                      markHoldElapsedMs: questionMarkCountdownMs(scenes[i]),
                    }
                  : drawOpts;
              drawSlidePair(ctx, scenes, i, i + 1, slideT, W, H, assets, drawOpts, fromOpts);
            }
          } else {
            drawSceneFrame(ctx, scenes[i], 1, W, H, assets, drawOpts);
          }
          drawn = true;
          break;
        }
        acc += block;
      }
      if (!drawn) {
        drawSceneFrame(ctx, scenes[scenes.length - 1], 1, W, H, assets, drawOpts);
      }
    }

    const name = `f${String(f).padStart(6, "0")}.png`;
    await ffmpeg.writeFile(name, await canvasToPngBytes(canvas));
    tick(1);
    if (f % 10 === 0 || f === totalFrames - 1) {
      onProgress(`rasterize · frame ${f + 1}/${totalFrames}`, frac());
    }
  }

  onProgress("encoding video…", frac());
  await ffmpeg.exec([
    "-y",
    "-framerate", String(fps),
    "-i", "f%06d.png",
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-movflags", "+faststart",
    "video.mp4",
  ]);
  tick(1);

  for (let f = 0; f < totalFrames; f++) {
    try { await ffmpeg.deleteFile(`f${String(f).padStart(6, "0")}.png`); } catch {}
  }

  onProgress("muxing audio…", frac());
  let finalName = "video.mp4";

  async function muxAudio(audioUrl: string, durationSec?: number) {
    await ffmpeg.writeFile("audio.dat", await fetchFile(audioUrl));
    const args = [
      "-y",
      "-i", "video.mp4",
      "-i", "audio.dat",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-map", "0:v:0",
      "-map", "1:a:0",
    ];
    if (durationSec != null && durationSec > 0) {
      args.push("-t", String(durationSec));
    } else {
      args.push("-shortest");
    }
    args.push("-movflags", "+faststart", "final.mp4");
    await ffmpeg.exec(args);
    finalName = "final.mp4";
  }

  const baseAudioUrl =
    masterAudioUrl ?? (scenes.length === 1 ? scenes[0]?.audioUrl : undefined);

  if (baseAudioUrl) {
    let audioUrl = baseAudioUrl;
    let mixedObjectUrl: string | null = null;
    if (exportNeedsAudioMix(scenes, masterMode, bgm)) {
      onProgress("mixing audio layers…", frac());
      const mixed = await mixExportAudio(scenes, baseAudioUrl, totalMs, masterMode, bgm);
      mixedObjectUrl = URL.createObjectURL(mixed);
      audioUrl = mixedObjectUrl;
    }
    await muxAudio(audioUrl, totalMs / 1000);
    if (mixedObjectUrl) URL.revokeObjectURL(mixedObjectUrl);
  } else if (exportNeedsAudioMix(scenes, masterMode, bgm)) {
    onProgress("mixing audio layers…", frac());
    const mixed = await mixExportAudio(scenes, undefined, totalMs, masterMode, bgm);
    const mixedObjectUrl = URL.createObjectURL(mixed);
    await muxAudio(mixedObjectUrl, totalMs / 1000);
    URL.revokeObjectURL(mixedObjectUrl);
  }
  tick(1);
  onProgress("finalizing…", 1);

  const data = (await ffmpeg.readFile(finalName)) as Uint8Array;
  const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: "video/mp4" });

  try { await ffmpeg.deleteFile("video.mp4"); } catch {}
  try { await ffmpeg.deleteFile("audio.dat"); } catch {}
  try { await ffmpeg.deleteFile("final.mp4"); } catch {}

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
