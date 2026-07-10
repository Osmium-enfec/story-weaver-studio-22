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
  loadVideo,
} from "./rasterize-scene";
import { DEFAULT_BACKGROUND, type SceneBackground } from "./scene-background";
import { preloadTransparent } from "./remove-white-bg";


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
  background: SceneBackground = DEFAULT_BACKGROUND,
): Promise<Blob> {
  const { w: W, h: H, fps, preset, crf } = PRESETS[quality];

  onProgress("loading ffmpeg…", 0);
  const ffmpeg = await getFFmpeg();

  onProgress("loading assets…", 0.02);
  const assets = await preloadSceneAssets(scenes);
  const transparentMap = background.kind === "whiteboard"
    ? new Map<string, string>()
    : await preloadTransparent(
        Array.from(new Set(scenes.flatMap((s) => (s.elements ?? []).map((e) => e.mediaUrl)))),
      );
  // Re-preload transparent versions as HTMLImageElements so the rasterizer
  // can draw them directly.
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

  // Preload the looping background video (if any) so we can seek per frame.
  const videoBgEl =
    background.kind === "video" ? await loadVideo(background.url).catch(() => null) : null;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;

  // Crossfade duration between scenes. Extend every scene (except last) by
  // FADE_DUR of held final frame so xfade overlap collapses back to the
  // original total duration and stays in sync with the master audio.
  const FADE_DUR = 0.5;
  const fadeFrames = Math.round(FADE_DUR * fps);

  const origDurSec = scenes.map((s) => sceneDurationMs(s) / 1000);
  const origFrames = origDurSec.map((d) => Math.max(1, Math.round(d * fps)));
  const extFrames = origFrames.map((n, i) =>
    i < scenes.length - 1 ? n + fadeFrames : n,
  );
  const totalFrames = extFrames.reduce((a, b) => a + b, 0);
  // units: 1 per rasterized frame + 1 per scene encode + (scenes-1) xfade passes + 1 mux
  const totalUnits = totalFrames + scenes.length + Math.max(0, scenes.length - 1) + 1;
  let unitsDone = 0;
  const frac = () => Math.min(0.999, unitsDone / totalUnits);
  const tick = (n = 1) => { unitsDone += n; return frac(); };

  const segments: string[] = [];
  const segDurSec: number[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const realFrames = origFrames[i];
    const frames = extFrames[i];
    const durSec = origDurSec[i];

    const video = scene.kind === "stock" && scene.mediaUrl
      ? assets.vid.get(scene.mediaUrl) ?? null
      : null;

    for (let f = 0; f < frames; f++) {
      // Trailing hold frames (f >= realFrames) freeze at progress=1 so the
      // xfade overlap looks like a still-frame crossfade into the next scene.
      const activeF = Math.min(f, realFrames - 1);
      const progress = realFrames <= 1 ? 0 : activeF / (realFrames - 1);
      const tSec = progress * durSec;

      if (video) {
        try { await seekVideo(video, tSec); } catch { /* ignore */ }
      }

      drawSceneFrame(ctx, scene, progress, W, H, assets, { background, transparent: transparentImgs });

      const bytes = await canvasToPngBytes(canvas);
      const name = `s${i}_f${String(f).padStart(5, "0")}.png`;
      await ffmpeg.writeFile(name, bytes);

      tick(1);
      if (f % 5 === 0 || f === frames - 1) {
        onProgress(
          `rasterize scene ${i + 1}/${scenes.length} · frame ${f + 1}/${frames}`,
          frac(),
        );
      }
    }

    onProgress(`encoding scene ${i + 1}/${scenes.length}`, frac());

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
    segDurSec.push(frames / fps);
    tick(1);
    onProgress(`encoded scene ${i + 1}/${scenes.length}`, frac());

    for (let f = 0; f < frames; f++) {
      try { await ffmpeg.deleteFile(`s${i}_f${String(f).padStart(5, "0")}.png`); } catch {}
    }
  }

  onProgress("stitching segments with fade…", frac());

  if (segments.length === 1) {
    await ffmpeg.exec(["-y", "-i", segments[0], "-c", "copy", "video.mp4"]);
  } else {
    // Pairwise xfade: only 2 inputs live at once (avoids OOM at 1080p60).
    // acc.mp4 = seg0; for i=1..n-1: acc.mp4 + seg{i} -> next.mp4 via xfade.
    await ffmpeg.exec(["-y", "-i", segments[0], "-c", "copy", "acc.mp4"]);
    let accDur = segDurSec[0];
    for (let i = 1; i < segments.length; i++) {
      const offset = accDur - FADE_DUR;
      const outName = i === segments.length - 1 ? "video.mp4" : "next.mp4";
      await ffmpeg.exec([
        "-y",
        "-i", "acc.mp4",
        "-i", segments[i],
        "-filter_complex",
        `[0:v][1:v]xfade=transition=fade:duration=${FADE_DUR}:offset=${offset.toFixed(3)},format=yuv420p[vout]`,
        "-map", "[vout]",
        "-c:v", "libx264",
        "-preset", preset,
        "-crf", String(crf),
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-movflags", "+faststart",
        outName,
      ]);
      accDur = accDur + segDurSec[i] - FADE_DUR;
      // Free the segment we just consumed + roll next -> acc
      try { await ffmpeg.deleteFile(segments[i]); } catch {}
      if (outName === "next.mp4") {
        try { await ffmpeg.deleteFile("acc.mp4"); } catch {}
        await ffmpeg.exec(["-y", "-i", "next.mp4", "-c", "copy", "acc.mp4"]);
        try { await ffmpeg.deleteFile("next.mp4"); } catch {}
      } else {
        try { await ffmpeg.deleteFile("acc.mp4"); } catch {}
      }
      tick(1);
      onProgress(`stitched ${i}/${segments.length - 1}`, frac());
    }
    try { await ffmpeg.deleteFile(segments[0]); } catch {}
  }
  onProgress("muxing audio…", frac());

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
