// Browser fallback MP4 exporter (ffmpeg.wasm). Prefer exportToMp4Native for local Mac encodes.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { Scene } from "@/components/VideoPlayer";
import {
  rasterizeExportFrames,
  type ExportQuality,
  type StageProgress,
  EXPORT_PRESETS,
} from "./export-rasterize";
import { DEFAULT_BACKGROUND, type SceneBackground } from "./scene-background";
import type { PartBgmConfig } from "./part-bgm";

export type { ExportQuality, StageProgress };

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

export async function exportToMp4(
  scenes: Scene[],
  masterAudioUrl: string | undefined,
  quality: ExportQuality,
  onProgress: StageProgress,
  background: SceneBackground = DEFAULT_BACKGROUND,
  bgm?: PartBgmConfig | null,
): Promise<Blob> {
  const { fps, preset, crf } = EXPORT_PRESETS[quality];

  onProgress("loading ffmpeg…", 0);
  const ffmpeg = await getFFmpeg();

  const { totalMs, totalFrames, audioBlob } = await rasterizeExportFrames({
    scenes,
    masterAudioUrl,
    quality,
    background,
    bgm,
    onProgress,
    onFrame: async (png, f) => {
      const name = `f${String(f).padStart(6, "0")}.png`;
      await ffmpeg.writeFile(name, png);
    },
  });

  onProgress("encoding video…", 0.9);
  await ffmpeg.exec([
    "-y",
    "-framerate",
    String(fps),
    "-i",
    "f%06d.png",
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-movflags",
    "+faststart",
    "video.mp4",
  ]);

  for (let f = 0; f < totalFrames; f++) {
    try {
      await ffmpeg.deleteFile(`f${String(f).padStart(6, "0")}.png`);
    } catch {
      /* ignore */
    }
  }

  onProgress("muxing audio…", 0.95);
  let finalName = "video.mp4";

  if (audioBlob) {
    await ffmpeg.writeFile("audio.dat", new Uint8Array(await audioBlob.arrayBuffer()));
    await ffmpeg.exec([
      "-y",
      "-i",
      "video.mp4",
      "-i",
      "audio.dat",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-t",
      String(totalMs / 1000),
      "-movflags",
      "+faststart",
      "final.mp4",
    ]);
    finalName = "final.mp4";
  }

  onProgress("finalizing…", 1);
  const data = (await ffmpeg.readFile(finalName)) as Uint8Array;
  const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: "video/mp4" });

  try {
    await ffmpeg.deleteFile("video.mp4");
  } catch {
    /* ignore */
  }
  try {
    await ffmpeg.deleteFile("audio.dat");
  } catch {
    /* ignore */
  }
  try {
    await ffmpeg.deleteFile("final.mp4");
  } catch {
    /* ignore */
  }

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
