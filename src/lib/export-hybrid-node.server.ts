/**
 * Hybrid native export: FFmpeg bakes media frames + encodes; Node canvas composites
 * (no Playwright Chromium for the frame loop).
 */

import { existsSync } from "node:fs";
import path from "node:path";
// Native modules are loaded lazily with runtime specifiers so bundlers targeting
// non-Node runtimes never try to inline the .node binaries.
type CanvasMod = typeof import("@napi-rs/canvas");
type AudioMod = typeof import("node-web-audio-api");

let canvasMod: CanvasMod | null = null;
let audioMod: AudioMod | null = null;

async function loadNativeModules(): Promise<void> {
  if (!canvasMod) {
    canvasMod = (await import(
      /* @vite-ignore */ ["@napi-rs", "canvas"].join("/")
    )) as CanvasMod;
  }
  if (!audioMod) {
    audioMod = (await import(
      /* @vite-ignore */ ["node-web", "audio-api"].join("-")
    )) as AudioMod;
  }
}

function createCanvas(w: number, h: number) {
  if (!canvasMod) throw new Error("Native canvas not loaded");
  return canvasMod.createCanvas(w, h);
}

function napiLoadImage(src: string | Buffer) {
  if (!canvasMod) throw new Error("Native canvas not loaded");
  return canvasMod.loadImage(src as never);
}

import {
  resolveExportAssetUrl,
  setExportNodeRuntime,
} from "@/lib/export-runtime";
import {
  rasterizeExportFrames,
  type ExportQuality,
  type RasterizeExportResult,
} from "@/lib/export-rasterize";
import type { Scene } from "@/components/VideoPlayer";
import type { SceneBackground } from "@/lib/scene-background";
import type { PartBgmConfig } from "@/lib/part-bgm";
import type { ExportBackgroundFrames } from "@/lib/export-job-types";
import { hostAppAssetsRoot, hostProjectAssetsRoot } from "@/lib/host-storage";

function pathnameFromExportUrl(url: string): string {
  const trimmed = url.trim();
  try {
    if (/^https?:\/\//i.test(trimmed)) return decodeURIComponent(new URL(trimmed).pathname);
  } catch {
    /* keep */
  }
  return decodeURIComponent(trimmed.split("?")[0]?.split("#")[0] ?? trimmed);
}

/** Prefer disk over HTTP — same-process fetch to *.local / 8080 often fails for stills. */
function localFileForExportImage(url: string): string | null {
  const pathname = pathnameFromExportUrl(url);
  const hit = (p: string) => (existsSync(p) ? p : null);

  if (pathname.startsWith("/api/assets/")) {
    const rel = pathname.slice("/api/assets/".length);
    if (!rel || rel.includes("..")) return null;
    return hit(path.join(hostProjectAssetsRoot(), rel));
  }
  if (pathname.startsWith("/api/app-assets/")) {
    const rel = pathname.slice("/api/app-assets/".length);
    if (!rel || rel.includes("..")) return null;
    return hit(path.join(hostAppAssetsRoot(), rel));
  }
  if (pathname.startsWith("/") && !pathname.startsWith("/api/")) {
    const rel = pathname.replace(/^\//, "");
    if (!rel || rel.includes("..")) return null;
    for (const root of [
      path.join(process.cwd(), "public"),
      path.join(process.cwd(), "dist", "client"),
      path.join(process.cwd(), ".output", "public"),
    ]) {
      const file = hit(path.join(root, rel));
      if (file) return file;
    }
  }
  return null;
}

async function nodeLoadImage(url: string): Promise<CanvasImageSource> {
  // Baked bg/recording frames are absolute disk paths. Do not prefix baseUrl
  // (that turns "/Users/..." into "http://localhost:8080/Users/...").
  if (url.startsWith("file:")) {
    const filePath = decodeURIComponent(url.replace(/^file:\/\//, ""));
    return (await napiLoadImage(filePath)) as unknown as CanvasImageSource;
  }
  if (path.isAbsolute(url) && existsSync(url)) {
    return (await napiLoadImage(url)) as unknown as CanvasImageSource;
  }

  const fromDisk = localFileForExportImage(url);
  if (fromDisk) {
    return (await napiLoadImage(fromDisk)) as unknown as CanvasImageSource;
  }

  const resolved = resolveExportAssetUrl(url);
  const fromResolvedDisk = localFileForExportImage(resolved);
  if (fromResolvedDisk) {
    return (await napiLoadImage(fromResolvedDisk)) as unknown as CanvasImageSource;
  }

  let img;
  if (resolved.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.+)$/i.exec(resolved);
    if (!m) throw new Error("Invalid data URL");
    img = await napiLoadImage(Buffer.from(m[2]!, "base64"));
  } else if (resolved.startsWith("file:")) {
    img = await napiLoadImage(
      decodeURIComponent(resolved.replace(/^file:\/\//, "")),
    );
  } else if (path.isAbsolute(resolved)) {
    if (!existsSync(resolved)) {
      throw new Error(`Export frame missing on disk: ${resolved}`);
    }
    img = await napiLoadImage(resolved);
  } else {
    const res = await fetch(resolved);
    if (!res.ok) throw new Error(`Failed to load image ${resolved} (${res.status})`);
    img = await napiLoadImage(Buffer.from(await res.arrayBuffer()));
  }
  return img as unknown as CanvasImageSource;
}

type GlobalBag = {
  document: unknown;
  hadDocument: boolean;
  AudioContext: unknown;
  hadAudioContext: boolean;
  OfflineAudioContext: unknown;
  hadOfflineAudioContext: boolean;
  self: unknown;
  hadSelf: boolean;
  window: unknown;
  hadWindow: boolean;
};

/**
 * Install canvas/audio shims for the hybrid frame loop.
 * MUST restore in finally — leaving `document` set makes TanStack Router
 * think it's in a browser (`typeof document !== "undefined"`) and crash
 * API routes with `ReferenceError: self is not defined`.
 *
 * While `document` is installed, also set `self`/`window` so concurrent
 * API status polls (same Node process) don't crash mid-export.
 */
function installNodeGlobals(): GlobalBag {
  const g = globalThis as Record<string, unknown>;
  const bag: GlobalBag = {
    document: g.document,
    hadDocument: Object.prototype.hasOwnProperty.call(g, "document"),
    AudioContext: g.AudioContext,
    hadAudioContext: Object.prototype.hasOwnProperty.call(g, "AudioContext"),
    OfflineAudioContext: g.OfflineAudioContext,
    hadOfflineAudioContext: Object.prototype.hasOwnProperty.call(
      g,
      "OfflineAudioContext",
    ),
    self: g.self,
    hadSelf: Object.prototype.hasOwnProperty.call(g, "self"),
    window: g.window,
    hadWindow: Object.prototype.hasOwnProperty.call(g, "window"),
  };

  g.AudioContext = audioMod?.AudioContext;
  g.OfflineAudioContext = audioMod?.OfflineAudioContext;

  // TanStack: `if (typeof document !== "undefined") self.__TSR_ROUTER__ = this`
  if (typeof g.self === "undefined") g.self = globalThis;
  if (typeof g.window === "undefined") g.window = globalThis;

  const prevDoc =
    (g.document as { createElement?: Function; fonts?: unknown } | undefined) ??
    {};
  g.document = {
    ...prevDoc,
    createElement: (tag: string, ...args: unknown[]) => {
      if (String(tag).toLowerCase() === "canvas") {
        return createCanvas(300, 150);
      }
      if (typeof prevDoc.createElement === "function") {
        return prevDoc.createElement(tag, ...args);
      }
      throw new Error(
        `document.createElement(${tag}) is not supported in hybrid export`,
      );
    },
    fonts: prevDoc.fonts ?? {
      load: async () => [],
      ready: Promise.resolve(),
    },
  };

  return bag;
}

function restoreNodeGlobals(bag: GlobalBag): void {
  const g = globalThis as Record<string, unknown>;
  if (bag.hadDocument) g.document = bag.document;
  else delete g.document;
  if (bag.hadAudioContext) g.AudioContext = bag.AudioContext;
  else delete g.AudioContext;
  if (bag.hadOfflineAudioContext) g.OfflineAudioContext = bag.OfflineAudioContext;
  else delete g.OfflineAudioContext;
  if (bag.hadSelf) g.self = bag.self;
  else delete g.self;
  if (bag.hadWindow) g.window = bag.window;
  else delete g.window;
}

export async function withHybridExportEnv<T>(
  baseUrl: string,
  fn: () => Promise<T>,
): Promise<T> {
  await loadNativeModules();
  const bag = installNodeGlobals();
  setExportNodeRuntime({
    enabled: true,
    baseUrl,
    loadImage: nodeLoadImage,
    createCanvas: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement,
  });
  try {
    return await fn();
  } finally {
    setExportNodeRuntime({ enabled: false });
    restoreNodeGlobals(bag);
  }
}

export async function rasterizeExportFramesHybrid(opts: {
  scenes: Scene[];
  masterAudioUrl?: string;
  quality: ExportQuality;
  background?: SceneBackground;
  bgm?: PartBgmConfig | null;
  backgroundFrames?: ExportBackgroundFrames & { urls: string[] };
  recordingVideos?: Array<{
    mediaUrl: string;
    fps: number;
    durationMs: number;
    urls: string[];
  }>;
  audioOnly?: boolean;
  frameStart?: number;
  frameEndExclusive?: number;
  skipAudio?: boolean;
  skipVideoUrls?: string[];
  signal?: AbortSignal;
  baseUrl: string;
  onFrame: (png: Uint8Array, frameIndex: number, totalFrames: number) => Promise<void>;
  onProgress?: (stage: string, ratio: number) => void;
}): Promise<RasterizeExportResult> {
  const { baseUrl, ...rest } = opts;
  return withHybridExportEnv(baseUrl, () => rasterizeExportFrames(rest));
}
