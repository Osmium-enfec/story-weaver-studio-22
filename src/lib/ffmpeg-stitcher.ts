// Hybrid MP4 exporter: rasterize each scene via canvas → PNG frames →
// ffmpeg.wasm encodes per-scene H.264 segments → concat → mux with the
// master audio track. Real MP4, seekable, correct duration, AAC audio.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { Scene } from "@/components/VideoPlayer";
import {
  preloadSceneAssets,
  drawSceneFrame,
  seekVideo,
} from "./rasterize-scene";

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

function sceneDurationMs(scene: Scene): number {
  if (scene.masterAudioUrl && scene.startMs != null && scene.endMs != null) {
    return Math.max(200, scene.endMs - scene.startMs);
  }
  return Math.max(200, scene.durationMs || 3000);
}

export async function exportToMp4(
  scenes: Scene[],
  masterAudioUrl: string | undefined,
  quality: ExportQuality,
  onProgress: StageProgress,
): Promise<Blob> {
  const { w: W, h: H, fps, preset, crf } = PRESETS[quality];

  onProgress("loading ffmpeg…", 0);
  const ffmpeg = await getFFmpeg();

  onProgress("loading assets…", 0.02);
  const assets = await preloadSceneAssets(scenes);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;

  // Compute work units: total frames + one encode per scene + concat + mux.
  const frameCounts = scenes.map((s) =>
    Math.max(1, Math.round((sceneDurationMs(s) / 1000) * fps)),
  );
  const totalFrames = frameCounts.reduce((a, b) => a + b, 0);
  const totalUnits = totalFrames + scenes.length + 2;
  let unitsDone = 0;
  const tick = (n = 1) => {
    unitsDone += n;
    return unitsDone / totalUnits;
  };

  const segments: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const frames = frameCounts[i];
    const durSec = sceneDurationMs(scene) / 1000;

    // If stock scene, seek the video per frame for deterministic capture.
    const video = scene.kind === "stock" && scene.mediaUrl
      ? assets.vid.get(scene.mediaUrl) ?? null
      : null;

    for (let f = 0; f < frames; f++) {
      const progress = frames <= 1 ? 0 : f / (frames - 1);
      const tSec = progress * durSec;

      if (video) {
        try { await seekVideo(video, tSec); } catch { /* ignore */ }
      }

      drawSceneFrame(ctx, scene, progress, W, H, assets);

      const bytes = await canvasToPngBytes(canvas);
      const name = `s${i}_f${String(f).padStart(5, "0")}.png`;
      await ffmpeg.writeFile(name, bytes);

      if (f % 5 === 0 || f === frames - 1) {
        onProgress(
          `rasterize scene ${i + 1}/${scenes.length} · frame ${f + 1}/${frames}`,
          tick(f === frames - 1 ? frames - (f % 5) : 5) - 0.0001,
        );
      }
    }
    // Ensure counter matches even if we skipped a report.
    // (unitsDone is only used for progress display.)

    onProgress(`encoding scene ${i + 1}/${scenes.length}`, unitsDone / totalUnits);

    const segName = `seg${i}.mp4`;
    await ffmpeg.exec([
      "-y",
      "-framerate", String(fps),
      "-i", `s${i}_f%05d.png`,
      "-c:v", "libx264",
      "-preset", preset,
      "-crf", String(crf),
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-movflags", "+faststart",
      segName,
    ]);
    segments.push(segName);
    tick(1);
    onProgress(`encoded scene ${i + 1}/${scenes.length}`, unitsDone / totalUnits);

    // Clean up frame PNGs to keep wasm heap small.
    for (let f = 0; f < frames; f++) {
      try { await ffmpeg.deleteFile(`s${i}_f${String(f).padStart(5, "0")}.png`); } catch {}
    }
  }

  onProgress("stitching segments…", unitsDone / totalUnits);
  const concatList = segments.map((s) => `file '${s}'`).join("\n");
  await ffmpeg.writeFile("list.txt", new TextEncoder().encode(concatList));
  await ffmpeg.exec([
    "-y",
    "-f", "concat", "-safe", "0",
    "-i", "list.txt",
    "-c", "copy",
    "video.mp4",
  ]);
  tick(1);
  onProgress("muxing audio…", unitsDone / totalUnits);

  let finalName = "video.mp4";
  if (masterAudioUrl) {
    await ffmpeg.writeFile("audio.dat", await fetchFile(masterAudioUrl));
    await ffmpeg.exec([
      "-y",
      "-i", "video.mp4",
      "-i", "audio.dat",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      "final.mp4",
    ]);
    finalName = "final.mp4";
  }
  tick(1);
  onProgress("finalizing…", 1);

  const data = (await ffmpeg.readFile(finalName)) as Uint8Array;
  const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: "video/mp4" });

  // Cleanup
  for (const s of segments) { try { await ffmpeg.deleteFile(s); } catch {} }
  try { await ffmpeg.deleteFile("list.txt"); } catch {}
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
