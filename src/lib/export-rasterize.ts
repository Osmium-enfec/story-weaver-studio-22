import type { Scene } from "@/components/VideoPlayer";
import {
  preloadSceneAssets,
  drawMasterVisualFrame,
  drawSceneFrame,
  createSlideTransitionCache,
  drawCachedSlideTransition,
  seekVideo,
  loadVideo,
  loadImage,
  snapshotVideoBgFrame,
  recordingSourceTimeSec,
  type SlideTransitionCache,
} from "./rasterize-scene";
import { DEFAULT_BACKGROUND, type SceneBackground } from "./scene-background";
import { preloadTransparent } from "./remove-white-bg";
import { revealSpeechDurationMs } from "./reveal-schedule";
import {
  masterVisualAt,
  sceneGapMs,
  sceneHoldMs,
  sceneTransitionMs,
} from "./scene-transition";
import {
  questionPostSpeechAt,
  questionMarkCountdownMs,
  questionPreQuestionMs,
  questionPostSpeechVisualMs,
  questionTimelineAt,
} from "./question-scene-layout";
import {
  exportNeedsAudioMix,
  mixExportAudio,
  padAudioBlobToDuration,
} from "./export-audio-mix";
import type { PartBgmConfig } from "./part-bgm";
import { healScenesForExport } from "./compose-scene";
import { templateCountdownProgress } from "./template-scene-canvas";
import type { ExportBackgroundFrames } from "./export-job-types";
import {
  canvasToPngBytes,
  createExportCanvas,
  exportSourceSize,
  isExportNodeRuntime,
  resolveExportAssetUrl,
} from "./export-runtime";

export type ExportQuality = "preview" | "hd";
export type StageProgress = (stage: string, ratio: number) => void;

export const EXPORT_PRESETS: Record<
  ExportQuality,
  { w: number; h: number; fps: number; preset: string; crf: number }
> = {
  preview: { w: 1280, h: 720, fps: 30, preset: "ultrafast", crf: 26 },
  hd: { w: 1920, h: 1080, fps: 30, preset: "veryfast", crf: 20 },
};

export function masterTimelineDurationMs(scenes: Scene[]): number {
  if (scenes.length === 0) return 0;
  const last = scenes[scenes.length - 1]!;
  const start = last.startMs ?? 0;
  const speech = revealSpeechDurationMs(last);
  const pre = last.kind === "question" ? questionPreQuestionMs(last) : 0;
  const tail = last.kind === "question" ? questionPostSpeechVisualMs(last) : 0;
  const computed = start + pre + speech + tail;
  if (last.kind === "template" && last.templateKind === "countdown") {
    return computed;
  }
  if (last.endMs != null) return Math.max(last.endMs, computed);
  return computed;
}

export function perSceneTimelineDurationMs(scenes: Scene[]): number {
  return scenes.reduce((acc, s, i) => {
    const speech = revealSpeechDurationMs(s);
    const pre = s.kind === "question" ? questionPreQuestionMs(s) : 0;
    const tail =
      i < scenes.length - 1
        ? sceneGapMs(s)
        : s.kind === "question"
          ? questionPostSpeechVisualMs(s)
          : 0;
    return acc + pre + speech + tail;
  }, 0);
}

export interface RasterizeExportResult {
  totalMs: number;
  totalFrames: number;
  /** Mixed or base narration as a Blob when audio exists; null if silent. */
  audioBlob: Blob | null;
}

/**
 * Draw every export frame and optionally mix export audio.
 * Used by both in-browser wasm encode and the headless native-ffmpeg runner.
 */
export async function rasterizeExportFrames(opts: {
  scenes: Scene[];
  masterAudioUrl?: string;
  quality: ExportQuality;
  background?: SceneBackground;
  bgm?: PartBgmConfig | null;
  /** Pre-baked looping video bg stills (native export). Prefer over HTMLVideoElement. */
  backgroundFrames?: ExportBackgroundFrames & { urls: string[] };
  /** Pre-baked screen-recording stills (avoids headless black video frames). */
  recordingVideos?: Array<{
    mediaUrl: string;
    fps: number;
    durationMs: number;
    urls: string[];
  }>;
  /** Skip picture frames — only rebuild the mixed narration track (smart remux). */
  audioOnly?: boolean;
  /** Rasterize only [frameStart, frameEndExclusive) on the master clock. */
  frameStart?: number;
  frameEndExclusive?: number;
  /** Skip narration mix (used when splicing pictures onto an existing MP4). */
  skipAudio?: boolean;
  skipVideoUrls?: string[];
  signal?: AbortSignal;
  onFrame: (png: Uint8Array, frameIndex: number, totalFrames: number) => Promise<void>;
  onProgress?: StageProgress;
}): Promise<RasterizeExportResult> {
  const {
    scenes: rawScenes,
    masterAudioUrl,
    quality,
    background = DEFAULT_BACKGROUND,
    bgm,
    backgroundFrames,
    recordingVideos,
    audioOnly = false,
    frameStart,
    frameEndExclusive,
    skipAudio = false,
    skipVideoUrls: extraSkipVideoUrls,
    signal,
    onFrame,
    onProgress = () => {},
  } = opts;

  function throwIfAborted() {
    if (signal?.aborted) {
      throw new DOMException("Export rasterize aborted", "AbortError");
    }
  }

  const scenes = healScenesForExport(rawScenes);

  const { w: W, h: H, fps } = EXPORT_PRESETS[quality];
  const resolvedMaster =
    masterAudioUrl ?? scenes.find((s) => s.masterAudioUrl)?.masterAudioUrl;
  // Master timeline math needs stitched windows. Without startMs/endMs it
  // collapses to "last scene duration from t=0" (e.g. an 8s outro → 8s export).
  const hasMasterWindows =
    scenes.length > 0 &&
    scenes.every((s) => s.startMs != null && s.endMs != null);
  const masterMode =
    !!resolvedMaster &&
    hasMasterWindows &&
    scenes.every((s) => s.masterAudioUrl === resolvedMaster);

  const totalMsEarly = masterMode
    ? masterTimelineDurationMs(scenes)
    : perSceneTimelineDurationMs(scenes);

  if (audioOnly) {
    onProgress("rebuilding narration audio…", 0.4);
    const baseAudioUrl =
      resolvedMaster ?? (scenes.length === 1 ? scenes[0]?.audioUrl : undefined);
    let audioBlob: Blob | null = null;
    if (baseAudioUrl) {
      if (exportNeedsAudioMix(scenes, masterMode, bgm)) {
        audioBlob = await mixExportAudio(
          scenes,
          baseAudioUrl,
          totalMsEarly,
          masterMode,
          bgm,
        );
      } else {
        const audioFetchUrl = isExportNodeRuntime()
          ? resolveExportAssetUrl(baseAudioUrl)
          : baseAudioUrl;
        const res = await fetch(audioFetchUrl);
        if (!res.ok) throw new Error(`Failed to fetch audio (${res.status})`);
        audioBlob = await padAudioBlobToDuration(await res.blob(), totalMsEarly);
      }
    } else if (exportNeedsAudioMix(scenes, masterMode, bgm)) {
      audioBlob = await mixExportAudio(scenes, undefined, totalMsEarly, masterMode, bgm);
    } else if (scenes.length > 1) {
      throw new Error(
        "Export has no narration track. Stitch the part, Save part, then export again.",
      );
    }
    if (!audioBlob && scenes.length > 1) {
      throw new Error("Smart re-export could not rebuild narration audio.");
    }
    return { totalMs: totalMsEarly, totalFrames: 0, audioBlob };
  }

  onProgress("loading assets…", 0.02);
  const bakedRecordingUrls = new Set(
    [
      ...(recordingVideos ?? []).map((rv) => rv.mediaUrl),
      ...(extraSkipVideoUrls ?? []),
    ].filter(Boolean),
  );
  // Skip decoding full MP4s in Chromium when ffmpeg already baked PNG stills —
  // loading intro/outro + long recordings as <video> OOMs small droplets.
  const assets = await preloadSceneAssets(scenes, {
    skipVideoUrls: bakedRecordingUrls,
  });
  const transparentMap =
    background.kind === "whiteboard"
      ? new Map<string, string>()
      : await preloadTransparent(
          Array.from(new Set(scenes.flatMap((s) => (s.elements ?? []).map((e) => e.mediaUrl)))),
        );
  const transparentImgs = new Map<string, HTMLImageElement>();
  await Promise.all(
    Array.from(transparentMap.entries()).map(async ([orig, url]) => {
      try {
        const img = await loadImage(url);
        transparentImgs.set(orig, img);
      } catch {
        /* keep original */
      }
    }),
  );

  /** Cap decoded stills in RAM — full preload of long recordings OOMs (~3.6MB/frame RGBA). */
  const FRAME_CACHE_MAX = 36;

  type LazyFrameSource = {
    fps: number;
    urls: string[];
    cache: Map<number, HTMLImageElement>;
    order: number[];
  };

  async function frameFromLazy(
    src: LazyFrameSource,
    idx: number,
  ): Promise<HTMLImageElement | undefined> {
    if (src.urls.length === 0) return undefined;
    const i = Math.min(src.urls.length - 1, Math.max(0, idx));
    const hit = src.cache.get(i);
    if (hit) {
      const pos = src.order.indexOf(i);
      if (pos >= 0) {
        src.order.splice(pos, 1);
        src.order.push(i);
      }
      return hit;
    }
    const img = await loadImage(src.urls[i]!);
    src.cache.set(i, img);
    src.order.push(i);
    while (src.order.length > FRAME_CACHE_MAX) {
      const evict = src.order.shift();
      if (evict != null) src.cache.delete(evict);
    }
    return img;
  }

  const bakedBg: LazyFrameSource | null =
    backgroundFrames?.urls?.length
      ? {
          fps: backgroundFrames.fps ?? 15,
          urls: backgroundFrames.urls,
          cache: new Map(),
          order: [],
        }
      : null;
  if (bakedBg) {
    onProgress("preparing video background frames…", 0.03);
  }

  /** mediaUrl → lazy stills for screen recordings */
  const bakedRecByUrl = new Map<string, LazyFrameSource>();
  if (recordingVideos?.length) {
    onProgress("preparing screen recording frames…", 0.04);
    for (const rv of recordingVideos) {
      if (!rv.urls?.length) continue;
      bakedRecByUrl.set(rv.mediaUrl, {
        fps: rv.fps,
        urls: rv.urls,
        cache: new Map(),
        order: [],
      });
    }
  }

  const videoBgEl =
    !bakedBg && background.kind === "video"
      ? await loadVideo(background.url).catch(() => null)
      : null;

  async function seekRecordingAt(
    scene: Scene,
    elapsedSpeechMs: number,
  ): Promise<void> {
    if (scene.kind !== "recording" || !scene.mediaUrl) {
      drawOpts.recordingFrame = undefined;
      return;
    }
    const sourceSec = recordingSourceTimeSec(scene, elapsedSpeechMs);
    const baked = bakedRecByUrl.get(scene.mediaUrl);
    if (baked && baked.urls.length > 0) {
      const idx = Math.min(
        baked.urls.length - 1,
        Math.max(0, Math.floor(sourceSec * baked.fps)),
      );
      drawOpts.recordingFrame = await frameFromLazy(baked, idx);
      return;
    }
    drawOpts.recordingFrame = undefined;
    const v = assets.vid.get(scene.mediaUrl);
    if (!v) return;
    try {
      await seekVideo(v, sourceSec);
    } catch {
      /* ignore seek errors */
    }
  }

  const canvas = createExportCanvas(W, H) as HTMLCanvasElement;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;

  const drawOpts = {
    background,
    transparent: transparentImgs,
    videoBg: videoBgEl ?? undefined,
    videoBgFrame: undefined as CanvasImageSource | undefined,
    recordingFrame: undefined as CanvasImageSource | undefined,
  };

  const bgFrameCache = new Map<number, HTMLCanvasElement>();
  const bakedFps = bakedBg?.fps ?? 15;
  const bakedCount = bakedBg?.urls.length ?? 0;

  async function pickBakedBg(ms: number): Promise<HTMLImageElement | null> {
    if (!bakedBg || bakedCount === 0) return null;
    const tSec = Math.max(0, ms) / 1000;
    const idx = Math.floor(tSec * bakedFps) % bakedCount;
    return (await frameFromLazy(bakedBg, idx)) ?? null;
  }

  async function seekBackgroundAt(ms: number): Promise<void> {
    const baked = await pickBakedBg(ms);
    if (baked) {
      drawOpts.videoBgFrame = baked;
      return;
    }
    if (!videoBgEl) {
      drawOpts.videoBgFrame = undefined;
      return;
    }
    const cacheKey = Math.round(Math.max(0, ms));
    const cached = bgFrameCache.get(cacheKey);
    if (cached) {
      drawOpts.videoBgFrame = cached;
      return;
    }
    const dur = videoBgEl.duration || 1;
    try {
      await seekVideo(videoBgEl, (Math.max(0, ms) / 1000) % dur);
    } catch {
      /* ignore */
    }
    throwIfAborted();
    const snap = snapshotVideoBgFrame(videoBgEl, W, H);
    bgFrameCache.set(cacheKey, snap);
    drawOpts.videoBgFrame = snap;
  }

  const totalMs = masterMode
    ? masterTimelineDurationMs(scenes)
    : perSceneTimelineDurationMs(scenes);
  const totalFrames = Math.max(1, Math.round((totalMs / 1000) * fps));
  const loopStart = Math.max(0, Math.min(totalFrames, frameStart ?? 0));
  const loopEnd = Math.max(
    loopStart,
    Math.min(totalFrames, frameEndExclusive ?? totalFrames),
  );
  const loopCount = Math.max(1, loopEnd - loopStart);
  let lastImageHoldKey = "";
  let lastImagePng: Uint8Array | null = null;

  let slideCache: SlideTransitionCache | null = null;

  function slideFromDrawOpts(scene: Scene) {
    return scene.kind === "question"
      ? {
          ...drawOpts,
          questionPhase: "mark" as const,
          markHoldElapsedMs: questionMarkCountdownMs(scene),
        }
      : drawOpts;
  }

  async function ensureSlideCache(
    from: number,
    to: number,
    bgTimeMs: number,
  ): Promise<void> {
    if (slideCache?.from === from && slideCache.to === to) return;
    await seekBackgroundAt(bgTimeMs);
    await seekRecordingAt(scenes[from]!, revealSpeechDurationMs(scenes[from]!));
    const fromRecFrame = drawOpts.recordingFrame;
    await seekRecordingAt(scenes[to]!, 0);
    const toRecFrame = drawOpts.recordingFrame;
    slideCache = createSlideTransitionCache(
      scenes,
      from,
      to,
      W,
      H,
      assets,
      { ...drawOpts, recordingFrame: toRecFrame },
      { ...slideFromDrawOpts(scenes[from]!), recordingFrame: fromRecFrame },
    );
  }

  for (let f = loopStart; f < loopEnd; f++) {
    throwIfAborted();
    const tMs = (f / fps) * 1000;

    if (skipAudio) {
      const vis = masterVisualAt(tMs, scenes);
      const scene = vis ? scenes[vis.sceneIndex] : undefined;
      if (scene?.kind === "image") {
        const speech = Math.max(1, revealSpeechDurationMs(scene));
        const progress = Math.min(1, Math.max(0, (vis?.elapsedSpeechMs ?? 0) / speech));
        const fade = Math.max(0.02, 450 / Math.max(1, scene.durationMs));
        const elKey = (scene.elements ?? [])
          .map((e) => {
            if (progress < e.appearAt) return "0";
            return String(Math.round(Math.min(1, (progress - e.appearAt) / fade) * 6));
          })
          .join(".");
        const holdKey = `${vis?.sceneIndex}:${elKey}:bg${Math.floor(tMs / 200)}`;
        if (holdKey === lastImageHoldKey && lastImagePng) {
          await onFrame(lastImagePng, f - loopStart, loopCount);
          continue;
        }
        lastImageHoldKey = holdKey;
      }
    }

    if (masterMode) {
      const vis = masterVisualAt(tMs, scenes);
      if (vis?.phase === "transition" && vis.fromIndex !== vis.toIndex) {
        const fromScene = scenes[vis.fromIndex]!;
        const bgTimeMs = Math.max(
          0,
          (fromScene.endMs ?? tMs) - sceneTransitionMs(fromScene),
        );
        await ensureSlideCache(vis.fromIndex, vis.toIndex, bgTimeMs);
        drawCachedSlideTransition(ctx, slideCache!, vis.slideT, W, H);
      } else {
        slideCache = null;
        await seekBackgroundAt(tMs);
        if (vis) {
          await seekRecordingAt(scenes[vis.sceneIndex]!, vis.elapsedSpeechMs);
        }
        drawMasterVisualFrame(ctx, scenes, tMs, W, H, assets, drawOpts);
      }
    } else {
      let acc = 0;
      let drawn = false;
      for (let i = 0; i < scenes.length; i++) {
        const speech = revealSpeechDurationMs(scenes[i]!);
        const pre = scenes[i]!.kind === "question" ? questionPreQuestionMs(scenes[i]!) : 0;
        const gap =
          i < scenes.length - 1
            ? sceneGapMs(scenes[i]!)
            : scenes[i]!.kind === "question"
              ? questionPostSpeechVisualMs(scenes[i]!)
              : 0;
        const holdMs = sceneHoldMs(scenes[i]!);
        const transitionMs = sceneTransitionMs(scenes[i]!);
        const block = pre + speech + gap;
        if (tMs < acc + block) {
          const local = tMs - acc;
          if (local < pre + speech) {
            slideCache = null;
            await seekBackgroundAt(tMs);
            if (scenes[i]!.kind === "question") {
              const timeline = questionTimelineAt(local, scenes[i]!, speech);
              drawSceneFrame(ctx, scenes[i]!, timeline.questionProgress, W, H, assets, {
                ...drawOpts,
                questionPhase: timeline.phase,
                markHoldElapsedMs: timeline.markElapsedMs,
              });
            } else {
              const elapsed = Math.max(0, local - pre);
              let drawProgress =
                speech <= 1 ? 0 : Math.min(1, Math.max(0, elapsed / speech));
              if (
                scenes[i]!.kind === "template" &&
                scenes[i]!.templateKind === "countdown"
              ) {
                drawProgress = templateCountdownProgress(
                  elapsed,
                  scenes[i]!.templateCountdownSec,
                );
              }
              await seekRecordingAt(scenes[i]!, elapsed);
              drawSceneFrame(ctx, scenes[i]!, drawProgress, W, H, assets, {
                ...drawOpts,
                elapsedSpeechMs: elapsed,
              });
            }
          } else if (i < scenes.length - 1) {
            const gapLocal = local - pre - speech;
            if (gapLocal < holdMs) {
              slideCache = null;
              await seekBackgroundAt(tMs);
              if (scenes[i]!.kind === "question") {
                const post = questionPostSpeechAt(gapLocal, scenes[i]!);
                const qPhase =
                  post.phase === "gap" ? ("mark-gap" as const) : ("mark" as const);
                drawSceneFrame(ctx, scenes[i]!, 1, W, H, assets, {
                  ...drawOpts,
                  questionPhase: qPhase,
                  markHoldElapsedMs: post.markElapsedMs,
                });
              } else {
                await seekRecordingAt(scenes[i]!, speech);
                drawSceneFrame(ctx, scenes[i]!, 1, W, H, assets, {
                  ...drawOpts,
                  elapsedSpeechMs: speech,
                });
              }
            } else {
              const bgTimeMs = acc + pre + speech + holdMs;
              const slideT = Math.min(1, (gapLocal - holdMs) / transitionMs);
              await ensureSlideCache(i, i + 1, bgTimeMs);
              drawCachedSlideTransition(ctx, slideCache!, slideT, W, H);
            }
          } else {
            slideCache = null;
            await seekBackgroundAt(tMs);
            const gapLocal = local - pre - speech;
            if (scenes[i]!.kind === "question") {
              const post = questionPostSpeechAt(gapLocal, scenes[i]!);
              const qPhase =
                post.phase === "gap" ? ("mark-gap" as const) : ("mark" as const);
              drawSceneFrame(ctx, scenes[i]!, 1, W, H, assets, {
                ...drawOpts,
                questionPhase: qPhase,
                markHoldElapsedMs: post.markElapsedMs,
              });
            } else {
              await seekRecordingAt(scenes[i]!, speech);
              drawSceneFrame(ctx, scenes[i]!, 1, W, H, assets, {
                ...drawOpts,
                elapsedSpeechMs: speech,
              });
            }
          }
          drawn = true;
          break;
        }
        acc += block;
      }
      if (!drawn) {
        slideCache = null;
        await seekBackgroundAt(tMs);
        const last = scenes[scenes.length - 1]!;
        await seekRecordingAt(last, revealSpeechDurationMs(last));
        drawSceneFrame(ctx, last, 1, W, H, assets, {
          ...drawOpts,
          elapsedSpeechMs: revealSpeechDurationMs(last),
        });
      }
    }

    const png = await canvasToPngBytes(canvas);
    throwIfAborted();
    if (skipAudio) lastImagePng = png;
    await onFrame(png, f - loopStart, loopCount);
    if ((f - loopStart) % 10 === 0 || f === loopEnd - 1) {
      const ratio = 0.05 + 0.75 * ((f - loopStart + 1) / loopCount);
      onProgress(`rasterize · frame ${f + 1}/${totalFrames}`, ratio);
    }
  }

  if (skipAudio) {
    return { totalMs, totalFrames, audioBlob: null };
  }

  const baseAudioUrl =
    resolvedMaster ?? (scenes.length === 1 ? scenes[0]?.audioUrl : undefined);

  let audioBlob: Blob | null = null;
  if (baseAudioUrl) {
    if (exportNeedsAudioMix(scenes, masterMode, bgm)) {
      onProgress("mixing audio layers…", 0.88);
      audioBlob = await mixExportAudio(scenes, baseAudioUrl, totalMs, masterMode, bgm);
    } else {
      onProgress("loading audio…", 0.88);
      const audioFetchUrl = isExportNodeRuntime()
        ? resolveExportAssetUrl(baseAudioUrl)
        : baseAudioUrl;
      const res = await fetch(audioFetchUrl);
      if (!res.ok) throw new Error(`Failed to fetch audio (${res.status})`);
      const rawBlob = await res.blob();
      audioBlob = await padAudioBlobToDuration(rawBlob, totalMs);
    }
  } else if (exportNeedsAudioMix(scenes, masterMode, bgm)) {
    onProgress("mixing audio layers…", 0.88);
    audioBlob = await mixExportAudio(scenes, undefined, totalMs, masterMode, bgm);
  } else if (scenes.length > 1) {
    // Never finish a multi-scene part as a silent MP4 — that looked "successful"
    // on other machines when master narration assets were missing.
    throw new Error(
      "Export has no narration track. Stitch the part, Save part, then export again. If you switched computers, sync .data/project-assets first.",
    );
  }

  return { totalMs, totalFrames, audioBlob };
}
