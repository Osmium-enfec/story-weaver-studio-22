/**
 * Runtime switch for hybrid native export (Node canvas + FFmpeg).
 * Browser wasm/export-runner keeps the DOM path; Node jobs flip this on.
 *
 * IMPORTANT: This module is imported by client UI (template preview, compose).
 * Do not import @napi-rs/canvas or other Node-only packages here.
 */

export type ExportCanvas = HTMLCanvasElement & {
  toBuffer?: (mime?: string) => Buffer;
};

let nodeMode = false;
let baseUrl = "http://127.0.0.1:8080";
let loadImageImpl: ((url: string) => Promise<CanvasImageSource>) | null = null;
let createCanvasImpl: ((w: number, h: number) => ExportCanvas) | null = null;

export function isExportNodeRuntime(): boolean {
  return nodeMode;
}

export function getExportBaseUrl(): string {
  return baseUrl;
}

export function setExportNodeRuntime(opts: {
  enabled: boolean;
  baseUrl?: string;
  loadImage?: (url: string) => Promise<CanvasImageSource>;
  createCanvas?: (w: number, h: number) => ExportCanvas;
}): void {
  nodeMode = opts.enabled;
  if (opts.baseUrl) baseUrl = opts.baseUrl.replace(/\/$/, "");
  loadImageImpl = opts.loadImage ?? null;
  createCanvasImpl = opts.createCanvas ?? null;
}

export function createExportCanvas(width: number, height: number): ExportCanvas {
  if (nodeMode && createCanvasImpl) {
    return createCanvasImpl(width, height);
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

export async function loadExportImage(url: string): Promise<CanvasImageSource> {
  if (nodeMode && loadImageImpl) {
    return loadImageImpl(url);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url.slice(0, 120)}`));
    img.src = url;
  });
}

/** Resolve relative asset URLs against the export base (Node fetch needs absolute). */
export function resolveExportAssetUrl(url: string): string {
  if (!url) return url;
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("file:") ||
    /^https?:\/\//i.test(url)
  ) {
    return url;
  }
  // Absolute filesystem paths (bg-frames, recording stills) — never prefix baseUrl.
  // `/Users/...` starts with `/` like `/bg-loop.mp4`, so we must distinguish them.
  if (
    url.startsWith("/Users/") ||
    url.startsWith("/home/") ||
    url.startsWith("/var/") ||
    url.startsWith("/tmp/") ||
    url.startsWith("/private/") ||
    url.startsWith("/opt/") ||
    url.startsWith("/Volumes/") ||
    /^[A-Za-z]:[\\/]/.test(url)
  ) {
    return url;
  }
  if (url.startsWith("/")) return `${baseUrl}${url}`;
  return `${baseUrl}/${url}`;
}

/** Duck-type pixel size for DOM Image/Video/Canvas and Node canvas Image. */
export function exportSourceSize(img: CanvasImageSource): { w: number; h: number } {
  const anyImg = img as {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  const w =
    Number(anyImg.videoWidth) ||
    Number(anyImg.naturalWidth) ||
    Number(anyImg.width) ||
    0;
  const h =
    Number(anyImg.videoHeight) ||
    Number(anyImg.naturalHeight) ||
    Number(anyImg.height) ||
    0;
  return { w, h };
}

export async function canvasToPngBytes(canvas: ExportCanvas): Promise<Uint8Array> {
  if (nodeMode && typeof canvas.toBuffer === "function") {
    const buf = canvas.toBuffer("image/png");
    return new Uint8Array(buf);
  }
  const el = canvas as HTMLCanvasElement;
  return new Promise((resolve, reject) => {
    el.toBlob(async (blob) => {
      if (!blob) return reject(new Error("canvas.toBlob returned null"));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}
