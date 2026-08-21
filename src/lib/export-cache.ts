import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Scene } from "@/components/VideoPlayer";
import type { ExportQuality } from "@/lib/export-rasterize";
import type { PartBgmConfig } from "@/lib/part-bgm";
import type { SceneBackground } from "@/lib/scene-background";
import { hostDataRoot } from "@/lib/host-storage";

/** Cross-job export reuse (video remux + recording frame bakes). */
export function exportCacheRoot(): string {
  return path.join(hostDataRoot(), "exports", "cache");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
      return sorted;
    }
    return v;
  });
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24);
}

/** Visual timeline fingerprint — changing only master audio should not bust this. */
export function hashExportVideo(opts: {
  scenes: Scene[];
  quality: ExportQuality;
  background?: SceneBackground;
}): string {
  const scenes = opts.scenes.map((s) => ({
    id: s.id,
    kind: s.kind,
    startMs: s.startMs,
    endMs: s.endMs,
    durationMs: s.durationMs,
    holdMs: s.holdMs,
    mediaUrl: s.mediaUrl,
    backgroundUrl: s.backgroundUrl,
    compositeThumbUrl: s.compositeThumbUrl,
    elements: s.elements,
    outTransition: s.outTransition,
    recordingTrimStartMs: s.recordingTrimStartMs,
    recordingTrimEndMs: s.recordingTrimEndMs,
    recordingVideoOffsetMs: s.recordingVideoOffsetMs,
    recordingVideoSegments: s.recordingVideoSegments,
    recordingCameraKeyframes: s.recordingCameraKeyframes,
    recordingCameraZoomDurationMs: s.recordingCameraZoomDurationMs,
    recordingBlurRegion: s.recordingBlurRegion,
    recordingHighlights: s.recordingHighlights,
    templateKind: s.templateKind,
    templateText: s.templateText,
    code: (s as { code?: string }).code,
    question: s.kind === "question" ? s : undefined,
    subtitle: s.subtitle,
    narrationText: s.narrationText,
  }));
  return hashPayload({
    quality: opts.quality,
    background: opts.background,
    scenes,
    renderVersion: "disk-images-v1",
  });
}

export function hashExportAudio(opts: {
  masterAudioUrl?: string | null;
  scenes: Scene[];
  bgm?: PartBgmConfig | null;
}): string {
  return hashPayload({
    master: opts.masterAudioUrl ?? null,
    bgm: opts.bgm ?? null,
    sceneAudio: opts.scenes.map((s) => ({
      id: s.id,
      audioUrl: s.audioUrl,
      questionMarkAudioUrl: s.questionMarkAudioUrl,
      questionIntroAudioUrl: s.questionIntroAudioUrl,
      elements: (s.elements ?? []).map((e) => ({
        sfxUrl: e.sfxUrl,
        startMs: (e as { startMs?: number }).startMs,
      })),
      recordingAudioSegments: s.recordingAudioSegments,
    })),
  });
}

export function hashRecordingBake(opts: {
  mediaUrl: string;
  quality: ExportQuality;
  bakeFps: number;
  fileKey?: string | null;
  /** Bump to invalidate PNG bakes after ffmpeg timestamp fixes. */
  bakeVersion?: string;
}): string {
  return hashPayload(opts);
}

export function recordingBakeCacheDir(bakeHash: string): string {
  return path.join(exportCacheRoot(), "rec-bakes", bakeHash);
}

export function resultCachePaths(videoHash: string, audioHash: string): {
  dir: string;
  video: string;
  final: string;
  meta: string;
} {
  const dir = path.join(exportCacheRoot(), "results", videoHash);
  return {
    dir,
    video: path.join(dir, "video-silent.mp4"),
    final: path.join(dir, `final-${audioHash}.mp4`),
    meta: path.join(dir, "meta.json"),
  };
}

export function readCachedFinal(videoHash: string, audioHash: string): string | null {
  const { final } = resultCachePaths(videoHash, audioHash);
  if (!existsSync(final) || statSync(final).size < 1024) return null;
  return final;
}

export function readCachedSilentVideo(videoHash: string): string | null {
  const { video } = resultCachePaths(videoHash, "x");
  if (!existsSync(video) || statSync(video).size < 1024) return null;
  return video;
}

export function writeCachedSilentVideo(videoHash: string, srcVideoPath: string): void {
  const { dir, video } = resultCachePaths(videoHash, "x");
  mkdirSync(dir, { recursive: true });
  const tmp = `${video}.tmp`;
  copyFileSync(srcVideoPath, tmp);
  renameSync(tmp, video);
}

export function writeCachedFinal(
  videoHash: string,
  audioHash: string,
  srcFinalPath: string,
): void {
  const { dir, final, meta } = resultCachePaths(videoHash, audioHash);
  mkdirSync(dir, { recursive: true });
  const tmp = `${final}.tmp`;
  copyFileSync(srcFinalPath, tmp);
  renameSync(tmp, final);
  writeFileSync(
    meta,
    JSON.stringify({ videoHash, audioHash, savedAt: Date.now() }),
  );
}

/** Copy a cached bake tree into the job's rec-frames folder when complete. */
export function tryRestoreRecordingBake(bakeHash: string, destDir: string): number {
  const src = recordingBakeCacheDir(bakeHash);
  if (!existsSync(src)) return 0;
  const list = readdirSync(src).filter((n) => /^f\d+\.png$/i.test(n));
  if (list.length === 0) return 0;
  mkdirSync(destDir, { recursive: true });
  for (const n of list) {
    copyFileSync(path.join(src, n), path.join(destDir, n));
  }
  return list.length;
}

export function saveRecordingBake(bakeHash: string, framesDir: string): void {
  const list = readdirSync(framesDir).filter((n) => /^f\d+\.png$/i.test(n));
  if (list.length === 0) return;
  const dest = recordingBakeCacheDir(bakeHash);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const n of list) {
    copyFileSync(path.join(framesDir, n), path.join(dest, n));
  }
}

export function localFileFingerprint(localPath: string | null | undefined): string | null {
  if (!localPath || !existsSync(localPath)) return null;
  const st = statSync(localPath);
  return `${st.size}:${Math.trunc(st.mtimeMs)}`;
}
