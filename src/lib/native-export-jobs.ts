import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  symlinkSync,
  rmSync,
  copyFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { unlink, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { hostExportsRoot } from "@/lib/host-exports";
import { hostProjectAssetsRoot } from "@/lib/host-storage";
import type { ExportJobPayload } from "@/lib/export-job-types";
import type { ExportQuality } from "@/lib/export-rasterize";
import {
  EXPORT_PRESETS,
  masterTimelineDurationMs,
} from "@/lib/export-rasterize";
import type { Scene } from "@/components/VideoPlayer";
import {
  hashExportAudio,
  hashExportVideo,
  hashRecordingBake,
  localFileFingerprint,
  readCachedFinal,
  readCachedSilentVideo,
  saveRecordingBake,
  tryRestoreRecordingBake,
  writeCachedFinal,
  writeCachedSilentVideo,
} from "@/lib/export-cache";

export type { ExportJobPayload };

const require = createRequire(import.meta.url);

/** How long the Playwright frame loop may run before we abort. */
function exportRenderTimeoutMs(totalMs: number, quality: ExportQuality): number {
  const fps = EXPORT_PRESETS[quality].fps;
  const frames = Math.max(1, Math.ceil((Math.max(0, totalMs) / 1000) * fps));
  // Prep + per-frame rasterize/encode budget (HD is heavier).
  const overheadMs = 10 * 60_000;
  const perFrameMs = quality === "hd" ? 180 : 90;
  const estimated = overheadMs + frames * perFrameMs;
  const minMs = quality === "hd" ? 120 * 60_000 : 30 * 60_000;
  const maxMs = 3 * 60 * 60_000;
  return Math.min(maxMs, Math.max(minMs, estimated));
}

export type ExportJobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface ExportJob {
  id: string;
  token: string;
  userId: string;
  status: ExportJobStatus;
  stage: string;
  progress: number;
  error?: string;
  payload: ExportJobPayload;
  baseUrl: string;
  createdAt: number;
  outputPath?: string;
  /** Set when the user asks to stop a queued/running job. */
  cancelRequested?: boolean;
  /** Filled on successful rasterize finish — helps diagnose short exports. */
  totalMs?: number;
  totalFrames?: number;
  sceneCount?: number;
}

/** Live process handles for cancel (not persisted). */
type JobRuntime = {
  browser: { close: () => Promise<void> } | null;
  procs: ChildProcess[];
};

const jobRuntime = new Map<string, JobRuntime>();

function getRuntime(jobId: string): JobRuntime {
  let rt = jobRuntime.get(jobId);
  if (!rt) {
    rt = { browser: null, procs: [] };
    jobRuntime.set(jobId, rt);
  }
  return rt;
}

function clearRuntime(jobId: string): void {
  jobRuntime.delete(jobId);
}

function throwIfCancelled(job: ExportJob): void {
  if (job.cancelRequested || job.status === "cancelled") {
    throw new Error("Export stopped by user");
  }
}

interface JobMetaFile {
  id: string;
  userId: string;
  token: string;
  status: ExportJobStatus;
  stage: string;
  progress: number;
  error?: string;
  filename: string;
  quality: ExportQuality;
  createdAt: number;
  outputFile?: string;
  baseUrl?: string;
  totalMs?: number;
  totalFrames?: number;
  sceneCount?: number;
}

export type ExportJobListItem = {
  jobId: string;
  status: ExportJobStatus;
  stage: string;
  progress: number;
  error?: string;
  filename: string;
  quality: ExportQuality;
  createdAt: number;
  userId: string;
};

const jobs = new Map<string, ExportJob>();
const lastMetaWriteAt = new Map<string, number>();

function jobDir(id: string): string {
  return path.join(hostExportsRoot(), id);
}

function metaPath(id: string): string {
  return path.join(jobDir(id), "meta.json");
}

function writeJobMeta(job: ExportJob, force = false): void {
  const now = Date.now();
  const last = lastMetaWriteAt.get(job.id) ?? 0;
  const terminal =
    job.status === "done" || job.status === "error" || job.status === "cancelled";
  if (!force && !terminal && now - last < 1500) return;
  lastMetaWriteAt.set(job.id, now);

  mkdirSync(jobDir(job.id), { recursive: true });
  const meta: JobMetaFile = {
    id: job.id,
    userId: job.userId,
    token: job.token,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    filename: job.payload.filename,
    quality: job.payload.quality,
    createdAt: job.createdAt,
    outputFile: job.outputPath ? path.basename(job.outputPath) : undefined,
    baseUrl: job.baseUrl,
    totalMs: job.totalMs,
    totalFrames: job.totalFrames,
    sceneCount: job.sceneCount,
  };
  writeFileSync(metaPath(job.id), JSON.stringify(meta, null, 2));
}

function readMetaFile(id: string): JobMetaFile | null {
  const p = metaPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as JobMetaFile;
  } catch {
    return null;
  }
}

function findOutputMp4(dir: string, preferredName?: string): string | null {
  if (preferredName) {
    const pref = path.join(dir, preferredName);
    if (existsSync(pref)) return pref;
  }
  try {
    const files = readdirSync(dir).filter(
      (f) => f.toLowerCase().endsWith(".mp4") && f !== "video.mp4",
    );
    if (files.length > 0) return path.join(dir, files[0]!);
    const video = path.join(dir, "video.mp4");
    if (existsSync(video)) return video;
  } catch {
    /* ignore */
  }
  return null;
}

/** Killed ffmpeg writes mdat without moov — those files cannot be resumed as video. */
function isCompleteMp4(file: string): boolean {
  try {
    const st = statSync(file);
    if (st.size < 8192) return false;
    const fd = openSync(file, "r");
    try {
      const headLen = Math.min(st.size, 64 * 1024);
      const head = Buffer.alloc(headLen);
      readSync(fd, head, 0, headLen, 0);
      const tailLen = Math.min(st.size, 2 * 1024 * 1024);
      const tail = Buffer.alloc(tailLen);
      readSync(fd, tail, 0, tailLen, st.size - tailLen);
      const moov = Buffer.from("moov");
      return head.includes(moov) || tail.includes(moov);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function discardIncompleteSilentVideo(jobId: string): void {
  const videoPath = path.join(jobDir(jobId), "video.mp4");
  if (existsSync(videoPath) && !isCompleteMp4(videoPath)) {
    try {
      unlinkSync(videoPath);
    } catch {
      /* ignore */
    }
  }
}

function healStuckMeta(meta: JobMetaFile): JobMetaFile {
  if (meta.status !== "running" && meta.status !== "queued") return meta;
  if (jobs.has(meta.id)) return meta;
  const dir = jobDir(meta.id);
  const out = findOutputMp4(dir, meta.filename);
  let next: JobMetaFile;
  if (out && path.basename(out) !== "video.mp4") {
    next = {
      ...meta,
      status: "done",
      stage: "done",
      progress: 1,
      error: undefined,
      outputFile: path.basename(out),
    };
  } else {
    next = {
      ...meta,
      status: "error",
      stage: "interrupted (server restarted)",
      error: "interrupted (server restarted)",
      progress: meta.progress,
      outputFile: out ? path.basename(out) : meta.outputFile,
    };
  }
  try {
    writeFileSync(metaPath(meta.id), JSON.stringify(next, null, 2));
  } catch {
    /* ignore */
  }
  return next;
}

/** Recover folders created before meta.json existed. */
function inferLegacyJob(id: string): ExportJobListItem | null {
  const dir = jobDir(id);
  const payloadPath = path.join(dir, "payload.json");
  if (!existsSync(payloadPath)) return null;
  let payload: ExportJobPayload;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf8")) as ExportJobPayload;
  } catch {
    return null;
  }
  const out = findOutputMp4(dir, payload.filename);
  const st = existsSync(dir) ? statSync(dir) : null;
  const createdAt = st?.mtimeMs ?? Date.now();
  const hasFinal = out != null && path.basename(out) !== "video.mp4";

  const meta: JobMetaFile = {
    id,
    userId: "",
    token: existsSync(path.join(dir, "token.txt"))
      ? readFileSync(path.join(dir, "token.txt"), "utf8").trim()
      : "",
    status: hasFinal ? "done" : "error",
    stage: hasFinal ? "done" : "interrupted (partial / failed)",
    progress: hasFinal ? 1 : 0.9,
    error: hasFinal ? undefined : "interrupted (partial / failed)",
    filename: payload.filename || path.basename(out ?? "export.mp4"),
    quality: payload.quality ?? "preview",
    createdAt,
    outputFile: out ? path.basename(out) : undefined,
  };
  try {
    writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  } catch {
    /* ignore */
  }
  return {
    jobId: id,
    status: meta.status,
    stage: meta.stage,
    progress: meta.progress,
    error: meta.error,
    filename: meta.filename,
    quality: meta.quality,
    createdAt: meta.createdAt,
    userId: meta.userId,
  };
}

function listJobsFromDisk(): ExportJobListItem[] {
  const root = hostExportsRoot();
  if (!existsSync(root)) return [];
  const ids = readdirSync(root).filter((name) => {
    try {
      return statSync(path.join(root, name)).isDirectory();
    } catch {
      return false;
    }
  });

  const items: ExportJobListItem[] = [];
  for (const id of ids) {
    const mem = jobs.get(id);
    if (mem) {
      items.push({
        jobId: mem.id,
        status: mem.status,
        stage: mem.stage,
        progress: mem.progress,
        error: mem.error,
        filename: mem.payload.filename,
        quality: mem.payload.quality,
        createdAt: mem.createdAt,
        userId: mem.userId,
      });
      continue;
    }
    const raw = readMetaFile(id);
    if (raw) {
      const meta = healStuckMeta(raw);
      items.push({
        jobId: meta.id,
        status: meta.status,
        stage: meta.stage,
        progress: meta.progress,
        error: meta.error,
        filename: meta.filename,
        quality: meta.quality,
        createdAt: meta.createdAt,
        userId: meta.userId,
      });
      continue;
    }
    const inferred = inferLegacyJob(id);
    if (inferred) items.push(inferred);
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

/** Export page keeps only the newest N jobs; older finished ones are deleted. */
export const MAX_LISTED_EXPORT_JOBS = 10;

function purgeExportJobFiles(jobId: string): void {
  jobs.delete(jobId);
  lastMetaWriteAt.delete(jobId);
  clearRuntime(jobId);
  try {
    rmSync(jobDir(jobId), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Keep the newest `MAX_LISTED_EXPORT_JOBS` exports (plus any still running/queued),
 * delete the rest from disk. Returns the kept list (newest first).
 */
export function pruneExportJobs(opts?: { userId?: string }): ExportJobListItem[] {
  let all = listJobsFromDisk();
  if (opts?.userId) {
    all = all.filter((j) => !j.userId || j.userId === opts.userId);
  }

  const keepIds = new Set<string>();
  const keep: ExportJobListItem[] = [];
  for (const j of all) {
    const active = j.status === "running" || j.status === "queued";
    if (keep.length < MAX_LISTED_EXPORT_JOBS || active) {
      if (!keepIds.has(j.jobId)) {
        keep.push(j);
        keepIds.add(j.jobId);
      }
    }
  }

  for (const j of all) {
    if (keepIds.has(j.jobId)) continue;
    if (j.status === "running" || j.status === "queued") continue;
    purgeExportJobFiles(j.jobId);
  }

  return keep.sort((a, b) => b.createdAt - a.createdAt);
}

function loadJobFromDisk(id: string): ExportJob | undefined {
  const mem = jobs.get(id);
  if (mem) return mem;

  let meta = readMetaFile(id);
  if (!meta) {
    inferLegacyJob(id);
    meta = readMetaFile(id);
  }
  if (!meta) return undefined;
  meta = healStuckMeta(meta);

  const dir = jobDir(id);
  const payloadPath = path.join(dir, "payload.json");
  let payload: ExportJobPayload;
  if (existsSync(payloadPath)) {
    try {
      payload = JSON.parse(readFileSync(payloadPath, "utf8")) as ExportJobPayload;
    } catch {
      payload = { scenes: [], quality: meta.quality, filename: meta.filename };
    }
  } else {
    payload = { scenes: [], quality: meta.quality, filename: meta.filename };
  }

  const outputPath = meta.outputFile
    ? path.join(dir, meta.outputFile)
    : findOutputMp4(dir, meta.filename) ?? undefined;

  return {
    id,
    token: meta.token,
    userId: meta.userId,
    status: meta.status,
    stage: meta.stage,
    progress: meta.progress,
    error: meta.error,
    payload,
    baseUrl: meta.baseUrl ?? "",
    createdAt: meta.createdAt,
    outputPath: outputPath && existsSync(outputPath) ? outputPath : undefined,
  };
}

export function getExportJob(id: string): ExportJob | undefined {
  return jobs.get(id) ?? loadJobFromDisk(id);
}

export function getExportJobForUser(id: string, userId: string): ExportJob | undefined {
  const job = getExportJob(id);
  if (!job) return undefined;
  // Legacy (empty userId) visible to any signed-in user on this Mac.
  if (job.userId && job.userId !== userId) return undefined;
  return job;
}

export function listExportJobsForUser(userId: string): ExportJobListItem[] {
  return pruneExportJobs({ userId });
}

/** Admin / overview: list without deleting. Prune happens on per-user Export page / new jobs. */
export function listAllExportJobs(): ExportJobListItem[] {
  return listJobsFromDisk();
}

export async function deleteExportJob(
  jobId: string,
  userId: string,
  asAdmin = false,
): Promise<void> {
  const job = getExportJob(jobId);
  if (!job) throw new Error("Export job not found");
  if (!asAdmin && job.userId && job.userId !== userId) {
    throw new Error("Not allowed to delete this export");
  }
  if (jobs.has(jobId) && (job.status === "running" || job.status === "queued")) {
    throw new Error("Cannot delete a job that is still running — stop it first");
  }
  jobs.delete(jobId);
  lastMetaWriteAt.delete(jobId);
  clearRuntime(jobId);
  await rm(jobDir(jobId), { recursive: true, force: true });
}

/** Stop a queued/running export. Safe to call repeatedly. */
export async function cancelExportJob(
  jobId: string,
  userId: string,
  asAdmin = false,
): Promise<void> {
  const job = getExportJob(jobId);
  if (!job) throw new Error("Export job not found");
  if (!asAdmin && job.userId && job.userId !== userId) {
    throw new Error("Not allowed to stop this export");
  }
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    return;
  }

  job.cancelRequested = true;
  job.status = "cancelled";
  job.stage = "stopped";
  job.error = "Stopped by user";
  job.progress = Math.min(job.progress, 1);
  writeJobMeta(job, true);

  const rt = jobRuntime.get(jobId);
  if (rt) {
    for (const p of rt.procs) {
      try {
        p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    rt.procs = [];
    if (rt.browser) {
      try {
        await rt.browser.close();
      } catch {
        /* ignore */
      }
      rt.browser = null;
    }
  }
}

function whichFfmpeg(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    // Prefer env only if it actually runs on this CPU (avoid x86 on arm64 → -86).
    const probe = spawnSync(fromEnv, ["-version"], { encoding: "utf8", timeout: 8000 });
    if (!probe.error && probe.status === 0) return fromEnv;
  }

  try {
    const staticPath = require("ffmpeg-static") as string | null;
    if (staticPath && existsSync(staticPath)) {
      const probe = spawnSync(staticPath, ["-version"], { encoding: "utf8", timeout: 8000 });
      if (!probe.error && probe.status === 0) return staticPath;
    }
  } catch {
    /* optional */
  }

  for (const candidate of [
    path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg"),
    path.join(process.cwd(), ".tools", "ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    `${process.env.HOME}/.local/bin/ffmpeg`,
    "/usr/bin/ffmpeg",
  ]) {
    if (!candidate || !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf8", timeout: 8000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return "ffmpeg";
}

export async function assertFfmpegAvailable(): Promise<string> {
  const bin = whichFfmpeg();
  await new Promise<void>((resolve, reject) => {
    const p = spawn(bin, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    p.on("error", () =>
      reject(
        new Error(
          "ffmpeg not found. Install with: brew install ffmpeg  (or set FFMPEG_PATH)",
        ),
      ),
    );
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("ffmpeg not found. Install with: brew install ffmpeg"));
    });
  });
  return bin;
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(-800)}`));
    });
  });
}

function ffmpegOutput(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(err));
  });
}

/**
 * Detect baked-in black matte (letterbox/pillarbox) on a screen recording.
 * Returns an ffmpeg `crop=w:h:x:y` value, or null when the frame is already clean.
 */
async function detectRecordingCrop(
  bin: string,
  src: string,
): Promise<string | null> {
  const out = await ffmpegOutput(bin, [
    "-hide_banner",
    "-ss",
    "2",
    "-t",
    "6",
    "-i",
    src,
    "-vf",
    "fps=2,cropdetect=24:2:0",
    "-f",
    "null",
    "-",
  ]);
  const matches = [...out.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const cw = Number(last[1]);
  const ch = Number(last[2]);
  const cx = Number(last[3]);
  const cy = Number(last[4]);
  if (!cw || !ch) return null;
  // Ignore a no-op crop and reject absurd crops (mostly-dark real content).
  const size = await ffmpegOutput(bin, ["-hide_banner", "-i", src]);
  const dim = size.match(/,\s(\d{2,5})x(\d{2,5})[\s,]/);
  const sw = dim ? Number(dim[1]) : 0;
  const sh = dim ? Number(dim[2]) : 0;
  if (sw && sh) {
    if (cw >= sw - 2 && ch >= sh - 2) return null;
    if (cw < sw * 0.35 || ch < sh * 0.35) return null;
  }
  return `crop=${cw}:${ch}:${cx}:${cy}`;
}

function resolvePublicVideoPath(url: string): string | null {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return null;
  const rel = url.replace(/^\//, "");
  const candidates = [
    path.join(process.cwd(), "public", rel),
    path.join(process.cwd(), "dist", "client", rel),
    path.join(process.cwd(), ".output", "public", rel),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Find an installed Chromium binary under PLAYWRIGHT_BROWSERS_PATH.
 * Prefer the real process.arch — Playwright's hostPlatform can wrongly pick
 * mac-x64 when os.cpus() is empty (common in sandboxed Node hosts).
 * Also resolves Linux Docker layouts (`chrome-linux64/chrome`).
 */
function resolvePlaywrightChromiumExecutable(browsersDir: string): string | null {
  if (!existsSync(browsersDir)) return null;
  const preferArm = process.arch === "arm64";
  const shellArchs = preferArm
    ? ["mac-arm64", "mac-x64", "linux64", "linux-arm64"]
    : ["mac-x64", "mac-arm64", "linux64", "linux-arm64"];
  const chromeArchs = preferArm
    ? ["chrome-mac-arm64", "chrome-mac-x64", "chrome-linux64", "chrome-linux"]
    : ["chrome-mac-x64", "chrome-mac-arm64", "chrome-linux64", "chrome-linux"];

  try {
    for (const entry of readdirSync(browsersDir)) {
      if (!entry.startsWith("chromium_headless_shell-")) continue;
      for (const arch of shellArchs) {
        const exe = path.join(
          browsersDir,
          entry,
          `chrome-headless-shell-${arch}`,
          "chrome-headless-shell",
        );
        if (existsSync(exe)) return exe;
      }
    }
    for (const entry of readdirSync(browsersDir)) {
      if (!entry.startsWith("chromium-") || entry.includes("headless")) continue;
      // Linux Playwright layout: chromium-NNNN/chrome-linux64/chrome
      for (const archDir of chromeArchs) {
        const linuxExe = path.join(browsersDir, entry, archDir, "chrome");
        if (existsSync(linuxExe)) return linuxExe;
        const exe = path.join(
          browsersDir,
          entry,
          archDir,
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        );
        if (existsSync(exe)) return exe;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function ensurePlaywrightArchSymlinks(browsersDir: string): void {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  if (!existsSync(browsersDir)) return;
  try {
    for (const entry of readdirSync(browsersDir)) {
      if (entry.startsWith("chromium_headless_shell-")) {
        const arm = path.join(browsersDir, entry, "chrome-headless-shell-mac-arm64");
        const x64 = path.join(browsersDir, entry, "chrome-headless-shell-mac-x64");
        if (existsSync(arm) && !existsSync(x64)) {
          symlinkSync("chrome-headless-shell-mac-arm64", x64, "dir");
        }
      }
      if (entry.startsWith("chromium-") && !entry.includes("headless")) {
        const arm = path.join(browsersDir, entry, "chrome-mac-arm64");
        const x64 = path.join(browsersDir, entry, "chrome-mac-x64");
        if (existsSync(arm) && !existsSync(x64)) {
          symlinkSync("chrome-mac-arm64", x64, "dir");
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Resolve /api/assets/… or public video paths for ffmpeg. */
async function resolveExportVideoPath(url: string, jobId: string): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("/api/assets/")) {
    const rel = url.slice("/api/assets/".length);
    if (!rel || rel.includes("..")) return null;
    const { useSpaces } = await import("@/lib/runtime-backends");
    if (useSpaces()) {
      const dest = path.join(jobDir(jobId), "assets", path.basename(rel));
      try {
        const { materializeAssetToFile } = await import("@/lib/object-storage");
        await materializeAssetToFile("project", rel, dest);
        return dest;
      } catch (e) {
        console.warn(`[export] failed to materialize asset ${rel}`, e);
        return null;
      }
    }
    const p = path.join(hostProjectAssetsRoot(), rel);
    if (existsSync(p)) return p;
    return null;
  }
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    const mime = m[1] ?? "video/mp4";
    const ext =
      mime.includes("webm") ? "webm" : mime.includes("quicktime") ? "mov" : "mp4";
    const out = path.join(jobDir(jobId), `src-recording-${randomBytes(6).toString("hex")}.${ext}`);
    writeFileSync(out, Buffer.from(m[2]!, "base64"));
    return out;
  }
  return resolvePublicVideoPath(url);
}

/**
 * Decode the looping video bg into PNG stills with ffmpeg.
 * Headless Chromium often draws seeked HTMLVideoElement frames as pure black;
 * pre-baked stills keep the orange loop visible and stable during slides.
 */
async function prepareVideoBackgroundFrames(
  ffmpegBin: string,
  job: ExportJob,
  quality: ExportQuality,
): Promise<void> {
  const bg = job.payload.background;
  if (!bg || bg.kind !== "video" || !bg.url) return;

  const src = resolvePublicVideoPath(bg.url);
  if (!src) {
    console.warn(`[export] video background not found on disk: ${bg.url}`);
    return;
  }

  const { w, h } = EXPORT_PRESETS[quality];
  const sampleFps = quality === "hd" ? 30 : 15;
  const framesDir = path.join(jobDir(job.id), "bg-frames");
  mkdirSync(framesDir, { recursive: true });

  job.stage = "preparing video background…";
  job.progress = 0.04;
  writeJobMeta(job, true);

  await runFfmpeg(ffmpegBin, [
    "-y",
    "-i",
    src,
    "-vf",
    `fps=${sampleFps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
    "-q:v",
    "3",
    path.join(framesDir, "f%04d.png"),
  ]);

  const files = readdirSync(framesDir)
    .filter((n) => /^f\d+\.png$/i.test(n))
    .sort();
  if (files.length === 0) {
    throw new Error("Failed to extract video background frames");
  }

  job.payload.backgroundFrames = {
    count: files.length,
    fps: sampleFps,
    loopMs: Math.round((files.length / sampleFps) * 1000),
  };
  writeFileSync(path.join(jobDir(job.id), "payload.json"), JSON.stringify(job.payload));
}

/**
 * Pre-bake screen-recording videos to PNG stills.
 * Same headless-black lesson as the bg-loop — seeked <video> frames are empty in Chromium.
 */
async function prepareRecordingVideoFrames(
  ffmpegBin: string,
  job: ExportJob,
  quality: ExportQuality,
): Promise<void> {
  const scenes = job.payload.scenes ?? [];
  const urls = [
    ...new Set(
      scenes
        .filter((s: Scene) => s.kind === "recording" && !!s.mediaUrl)
        .map((s: Scene) => s.mediaUrl!),
    ),
  ];
  if (urls.length === 0) return;

  const bakeFps = Math.min(30, EXPORT_PRESETS[quality].fps);
  const recordingVideos: NonNullable<ExportJobPayload["recordingVideos"]> = [];

  for (let i = 0; i < urls.length; i++) {
    const mediaUrl = urls[i]!;
    job.stage = `preparing screen recording ${i + 1}/${urls.length}…`;
    job.progress = 0.05 + (0.08 * i) / Math.max(1, urls.length);
    writeJobMeta(job, true);

    const src = await resolveExportVideoPath(mediaUrl, job.id);
    if (!src) {
      console.warn(`[export] recording video not found on disk: ${mediaUrl}`);
      continue;
    }

    // Trim baked-in black bars (letterbox/pillarbox) before rasterizing.
    const cropFilter = await detectRecordingCrop(ffmpegBin, src);
    if (cropFilter) {
      console.log(`[export] recording matte trim ${mediaUrl}: ${cropFilter}`);
    }

    const bakeHash = hashRecordingBake({
      mediaUrl,
      quality,
      bakeFps,
      fileKey: localFileFingerprint(src),
      bakeVersion: `pts-zero-v2:${cropFilter ?? "nocrop"}`,
    });
    const framesDir = path.join(jobDir(job.id), "rec-frames", String(i));
    mkdirSync(framesDir, { recursive: true });

    const restored = tryRestoreRecordingBake(bakeHash, framesDir);
    if (restored === 0) {
      await runFfmpeg(ffmpegBin, [
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        src,
        "-vf",
        `setpts=PTS-STARTPTS,fps=${bakeFps}`,
        "-vsync",
        "cfr",
        "-q:v",
        "3",
        path.join(framesDir, "f%04d.png"),
      ]);
      saveRecordingBake(bakeHash, framesDir);
    } else {
      job.stage = `reusing cached recording frames ${i + 1}/${urls.length}…`;
      writeJobMeta(job, true);
    }

    const files = readdirSync(framesDir)
      .filter((n) => /^f\d+\.png$/i.test(n))
      .sort();
    if (files.length === 0) {
      console.warn(`[export] no frames extracted for recording: ${mediaUrl}`);
      continue;
    }

    recordingVideos.push({
      mediaUrl,
      count: files.length,
      fps: bakeFps,
      durationMs: Math.round((files.length / bakeFps) * 1000),
    });
  }

  if (recordingVideos.length > 0) {
    job.payload.recordingVideos = recordingVideos;
    writeFileSync(path.join(jobDir(job.id), "payload.json"), JSON.stringify(job.payload));
  }
}

export function readJobBgFrame(
  jobId: string,
  token: string,
  frameIndex1Based: number,
): { bytes: Buffer; contentType: string } {
  // Validate token via payload reader
  readJobPayload(jobId, token);
  if (!Number.isFinite(frameIndex1Based) || frameIndex1Based < 1) {
    throw new Error("Invalid bg frame index");
  }
  const file = path.join(
    jobDir(jobId),
    "bg-frames",
    `f${String(frameIndex1Based).padStart(4, "0")}.png`,
  );
  if (!existsSync(file)) throw new Error("Background frame not found");
  return { bytes: readFileSync(file), contentType: "image/png" };
}

export function readJobRecordingFrame(
  jobId: string,
  token: string,
  videoIndex: number,
  frameIndex1Based: number,
): { bytes: Buffer; contentType: string } {
  readJobPayload(jobId, token);
  if (!Number.isFinite(videoIndex) || videoIndex < 0) {
    throw new Error("Invalid recording video index");
  }
  if (!Number.isFinite(frameIndex1Based) || frameIndex1Based < 1) {
    throw new Error("Invalid recording frame index");
  }
  const file = path.join(
    jobDir(jobId),
    "rec-frames",
    String(videoIndex),
    `f${String(frameIndex1Based).padStart(4, "0")}.png`,
  );
  if (!existsSync(file)) throw new Error("Recording frame not found");
  return { bytes: readFileSync(file), contentType: "image/png" };
}

export function createExportJob(opts: {
  userId: string;
  baseUrl: string;
  payload: ExportJobPayload;
}): ExportJob {
  const id = randomUUID();
  const token = randomBytes(24).toString("hex");
  const job: ExportJob = {
    id,
    token,
    userId: opts.userId,
    status: "queued",
    stage: "queued",
    progress: 0,
    payload: opts.payload,
    baseUrl: opts.baseUrl.replace(/\/$/, ""),
    createdAt: Date.now(),
    sceneCount: opts.payload.scenes.length,
  };
  jobs.set(id, job);

  const dir = jobDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "payload.json"), JSON.stringify(opts.payload));
  writeFileSync(path.join(dir, "token.txt"), job.token);
  writeJobMeta(job, true);

  // Drop older finished exports so the Export page stays at the last 10.
  pruneExportJobs({ userId: opts.userId });

  startJobExecution(job);

  return job;
}

function startJobExecution(job: ExportJob): void {
  void runNativeExportJob(job).catch((e: unknown) => {
    if (job.status === "cancelled" || job.cancelRequested) {
      job.status = "cancelled";
      job.stage = "stopped";
      job.error = "Stopped by user";
      writeJobMeta(job, true);
      clearRuntime(job.id);
      return;
    }
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
    job.stage = "error";
    writeJobMeta(job, true);
    clearRuntime(job.id);
  });
}

/** Continue a failed/stopped Studio Mac export using cache + baked frames when possible. */
export function resumeExportJob(
  jobId: string,
  userId: string,
  asAdmin = false,
): ExportJob {
  const loaded = getExportJob(jobId);
  if (!loaded) throw new Error("Export job not found");
  if (!asAdmin && loaded.userId && loaded.userId !== userId) {
    throw new Error("Not allowed to resume this export");
  }
  if (loaded.status === "running" || loaded.status === "queued") {
    throw new Error("Export is already running");
  }
  if (
    loaded.status === "done" &&
    loaded.outputPath &&
    existsSync(loaded.outputPath) &&
    isCompleteMp4(loaded.outputPath)
  ) {
    return loaded;
  }

  discardIncompleteSilentVideo(jobId);

  const job: ExportJob = {
    ...loaded,
    status: "queued",
    stage: "resuming…",
    error: undefined,
    cancelRequested: false,
    progress: Math.min(Math.max(loaded.progress || 0.02, 0.02), 0.2),
  };
  jobs.set(job.id, job);
  writeJobMeta(job, true);

  const sourceMp4 = findCompleteSourceMp4(job);
  if (
    sourceMp4 &&
    (job.payload.scenes ?? []).some((s) => s.kind === "image")
  ) {
    startImagePatchExecution(job, sourceMp4);
    return job;
  }

  startJobExecution(job);
  return job;
}

function findCompleteSourceMp4(job: ExportJob): string | null {
  if (
    job.outputPath &&
    path.basename(job.outputPath) !== "video.mp4" &&
    isCompleteMp4(job.outputPath)
  ) {
    return job.outputPath;
  }
  const root = hostExportsRoot();
  if (!existsSync(root)) return null;
  const want = job.payload.filename;
  let best: { path: string; createdAt: number } | null = null;
  for (const id of readdirSync(root)) {
    if (id === job.id || id === "cache") continue;
    const meta = readMetaFile(id);
    if (!meta || meta.status !== "done") continue;
    if (meta.filename !== want) continue;
    const mp4 = findOutputMp4(jobDir(id), meta.filename);
    if (!mp4 || path.basename(mp4) === "video.mp4" || !isCompleteMp4(mp4)) continue;
    const createdAt = meta.createdAt ?? 0;
    if (!best || createdAt > best.createdAt) best = { path: mp4, createdAt };
  }
  return best?.path ?? null;
}

function startImagePatchExecution(job: ExportJob, sourceMp4: string): void {
  void (async () => {
    try {
      job.status = "running";
      job.stage = "patching upload-image scenes…";
      job.progress = 0.05;
      writeJobMeta(job, true);
      const outMp4 = path.join(jobDir(job.id), job.payload.filename);
      await patchImageScenesOntoMp4({
        payload: job.payload,
        sourceMp4,
        outMp4,
        baseUrl: job.baseUrl || "http://127.0.0.1:8080",
        bgFrameDir: findBgFrameDir(job.id, sourceMp4),
        onProgress: (stage, ratio) => {
          job.stage = stage;
          job.progress = Math.min(0.95, Math.max(job.progress, ratio));
          writeJobMeta(job);
        },
      });
      job.outputPath = outMp4;
      job.status = "done";
      job.stage = "done (image scenes patched)";
      job.progress = 1;
      job.error = undefined;
      writeJobMeta(job, true);
    } catch (e: unknown) {
      job.status = "error";
      job.stage = "error";
      job.error = e instanceof Error ? e.message : String(e);
      writeJobMeta(job, true);
    } finally {
      clearRuntime(job.id);
    }
  })();
}

function findBgFrameDir(jobId: string, sourceMp4: string): string | undefined {
  for (const dir of [
    path.join(jobDir(jobId), "bg-frames"),
    path.join(path.dirname(sourceMp4), "bg-frames"),
  ]) {
    try {
      if (
        existsSync(dir) &&
        readdirSync(dir).some((f) => f.toLowerCase().endsWith(".png"))
      ) {
        return dir;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function encodePngPipeToMp4(
  ffmpegBin: string,
  outPath: string,
  fps: number,
  preset: string,
  crf: number,
): {
  write: (png: Uint8Array) => Promise<void>;
  finish: (expectedFrames: number) => Promise<void>;
} {
  const proc = spawn(
    ffmpegBin,
    [
      "-y",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-framerate",
      String(fps),
      "-i",
      "pipe:0",
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
      "-vsync",
      "cfr",
      outPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const stdin = proc.stdin;
  if (!stdin) throw new Error("ffmpeg stdin missing");
  let err = "";
  let frames = 0;
  let chain = Promise.resolve();
  proc.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
    if (err.length > 8000) err = err.slice(-4000);
  });
  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg encode failed (${code}): ${err.slice(-800)}`));
    });
  });
  return {
    write: (png) => {
      chain = chain.then(async () => {
        if (!stdin.write(Buffer.from(png))) {
          await new Promise<void>((r) => stdin.once("drain", r));
        }
        frames += 1;
      });
      return chain;
    },
    finish: async (expectedFrames) => {
      await chain;
      if (frames !== expectedFrames) {
        throw new Error(`Image clip produced ${frames} frames, expected ${expectedFrames}`);
      }
      stdin.end();
      await done;
    },
  };
}

/** Re-draw only kind=image scenes and splice them into an existing complete MP4. */
export async function patchImageScenesOntoMp4(opts: {
  payload: ExportJobPayload;
  sourceMp4: string;
  outMp4: string;
  baseUrl: string;
  bgFrameDir?: string;
  onProgress?: (stage: string, ratio: number) => void;
}): Promise<void> {
  const ffmpegBin = await assertFfmpegAvailable();
  const scenes = opts.payload.scenes ?? [];
  const quality = opts.payload.quality;
  const { fps, preset, crf } = EXPORT_PRESETS[quality];
  const totalMs = masterTimelineDurationMs(scenes);
  const totalFrames = Math.max(1, Math.round((totalMs / 1000) * fps));
  const imageRanges = scenes
    .filter((s) => s.kind === "image" && s.startMs != null && s.endMs != null)
    .map((s) => {
      const startF = Math.max(0, Math.ceil((s.startMs! / 1000) * fps));
      const endF = Math.min(totalFrames, Math.ceil((s.endMs! / 1000) * fps));
      return { startF, endF };
    })
    .filter((r) => r.endF > r.startF);
  if (!imageRanges.length) {
    copyFileSync(opts.sourceMp4, opts.outMp4);
    return;
  }

  const bgDir = opts.bgFrameDir;
  const bgUrls =
    bgDir && existsSync(bgDir)
      ? readdirSync(bgDir)
          .filter((f) => f.toLowerCase().endsWith(".png"))
          .sort()
          .map((f) => path.join(bgDir, f))
      : [];
  const skipVideoUrls = scenes
    .filter((s) => s.kind === "recording" && s.mediaUrl)
    .map((s) => s.mediaUrl!);

  const { rasterizeExportFramesHybrid } = await import("@/lib/export-hybrid-node.server");
  const workDir = path.dirname(opts.outMp4);
  mkdirSync(workDir, { recursive: true });
  const clipPaths: string[] = [];

  for (let i = 0; i < imageRanges.length; i++) {
    const range = imageRanges[i]!;
    const n = range.endF - range.startF;
    const clipPath = path.join(workDir, `image-patch-${i}.mp4`);
    opts.onProgress?.(
      `redrawing image scene ${i + 1}/${imageRanges.length}…`,
      0.08 + (i / imageRanges.length) * 0.7,
    );
    const pipe = encodePngPipeToMp4(ffmpegBin, clipPath, fps, preset, crf);
    await rasterizeExportFramesHybrid({
      scenes,
      masterAudioUrl: opts.payload.masterAudioUrl,
      quality,
      background: opts.payload.background,
      bgm: opts.payload.bgm,
      backgroundFrames:
        bgUrls.length > 0
          ? {
              count: bgUrls.length,
              fps: opts.payload.backgroundFrames?.fps ?? 30,
              loopMs: opts.payload.backgroundFrames?.loopMs ?? (bgUrls.length / 30) * 1000,
              urls: bgUrls,
            }
          : undefined,
      skipAudio: true,
      skipVideoUrls,
      frameStart: range.startF,
      frameEndExclusive: range.endF,
      baseUrl: opts.baseUrl,
      onProgress: (stage, ratio) => {
        opts.onProgress?.(
          stage,
          0.08 + ((i + ratio) / imageRanges.length) * 0.7,
        );
      },
      onFrame: async (png) => {
        await pipe.write(png);
      },
    });
    await pipe.finish(n);
    clipPaths.push(clipPath);
  }

  opts.onProgress?.("splicing image scenes into existing video…", 0.85);

  const parts: Array<{ kind: "src"; startF: number; endF: number } | { kind: "clip"; input: number }> =
    [];
  let cursor = 0;
  let clipInput = 1;
  for (let i = 0; i < imageRanges.length; i++) {
    const range = imageRanges[i]!;
    if (cursor < range.startF) {
      parts.push({ kind: "src", startF: cursor, endF: range.startF });
    }
    parts.push({ kind: "clip", input: clipInput });
    clipInput += 1;
    cursor = range.endF;
  }
  if (cursor < totalFrames) {
    parts.push({ kind: "src", startF: cursor, endF: totalFrames });
  }

  const args: string[] = ["-y", "-i", opts.sourceMp4];
  for (const p of clipPaths) args.push("-i", p);
  const filters: string[] = [];
  const concatLabels: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const label = `v${i}`;
    concatLabels.push(`[${label}]`);
    if (part.kind === "src") {
      filters.push(
        `[0:v]trim=start_frame=${part.startF}:end_frame=${part.endF},setpts=PTS-STARTPTS[${label}]`,
      );
    } else {
      filters.push(`[${part.input}:v]setpts=PTS-STARTPTS[${label}]`);
    }
  }
  filters.push(
    `${concatLabels.join("")}concat=n=${parts.length}:v=1:a=0[vout]`,
  );
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "0:a?",
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
    "-vsync",
    "cfr",
    "-c:a",
    "copy",
    "-shortest",
    "-movflags",
    "+faststart",
    opts.outMp4,
  );
  await runFfmpeg(ffmpegBin, args);
  for (const p of clipPaths) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

async function runNativeExportJob(job: ExportJob): Promise<void> {
  throwIfCancelled(job);
  job.status = "running";
  job.stage = "starting…";
  job.progress = 0.01;
  writeJobMeta(job, true);

  const ffmpegBin = await assertFfmpegAvailable();
  const dir = jobDir(job.id);
  mkdirSync(dir, { recursive: true });
  discardIncompleteSilentVideo(job.id);
  const videoPath = path.join(dir, "video.mp4");
  const audioPath = path.join(dir, "audio.dat");
  const finalPath = path.join(dir, job.payload.filename);

  const videoHash = hashExportVideo({
    scenes: job.payload.scenes,
    quality: job.payload.quality,
    background: job.payload.background,
  });
  const audioHash = hashExportAudio({
    masterAudioUrl: job.payload.masterAudioUrl,
    scenes: job.payload.scenes,
    bgm: job.payload.bgm,
  });

  // Exact match — return previous MP4 immediately (common re-click / re-export).
  const cachedFinal = readCachedFinal(videoHash, audioHash);
  if (cachedFinal) {
    job.stage = "reusing previous render…";
    job.progress = 0.95;
    writeJobMeta(job, true);
    copyFileSync(cachedFinal, finalPath);
    job.outputPath = finalPath;
    job.status = "done";
    job.stage = "done (cached)";
    job.progress = 1;
    writeJobMeta(job, true);
    clearRuntime(job.id);
    return;
  }

  const cachedSilent = readCachedSilentVideo(videoHash);
  if (cachedSilent) {
    // Same pictures, different narration/BGM — only rebuild audio + remux.
    job.payload.audioOnly = true;
    writeFileSync(path.join(dir, "payload.json"), JSON.stringify(job.payload));
    copyFileSync(cachedSilent, videoPath);
    job.stage = "reusing video — rebuilding audio…";
    job.progress = 0.2;
    writeJobMeta(job, true);
  }

  const { fps, preset, crf } = EXPORT_PRESETS[job.payload.quality];

  if (!job.payload.audioOnly) {
    await prepareVideoBackgroundFrames(ffmpegBin, job, job.payload.quality);
    await prepareRecordingVideoFrames(ffmpegBin, job, job.payload.quality);
  }

  const { rasterizeExportFramesHybrid } = await import("@/lib/export-hybrid-node.server");

  job.stage = "hybrid canvas + ffmpeg…";
  job.progress = 0.03;
  writeJobMeta(job);

  throwIfCancelled(job);

  const pipe = {
    proc: null as ChildProcess | null,
    stdin: null as NodeJS.WritableStream | null,
    done: null as Promise<void> | null,
    err: "",
    frames: 0,
    audio: false,
    expectedTotalFrames: null as number | null,
    expectedTotalMs: null as number | null,
    finished: false,
    writeChain: Promise.resolve() as Promise<void>,
  };

  const resetFfmpegPipe = () => {
    if (pipe.stdin) {
      try {
        pipe.stdin.end();
      } catch {
        /* ignore */
      }
      pipe.stdin = null;
    }
    if (pipe.proc) {
      try {
        pipe.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      pipe.proc = null;
      pipe.done = null;
    }
    pipe.frames = 0;
    pipe.expectedTotalFrames = null;
    pipe.expectedTotalMs = null;
    pipe.finished = false;
    pipe.writeChain = Promise.resolve();
    pipe.err = "";
    try {
      if (existsSync(videoPath)) unlinkSync(videoPath);
    } catch {
      /* ignore */
    }
  };

  const enqueueFrameWrite = (task: () => Promise<void>): Promise<void> => {
    pipe.writeChain = pipe.writeChain.then(task).catch((err) => {
      throw err instanceof Error ? err : new Error(String(err));
    });
    return pipe.writeChain;
  };

  const startFfmpegPipe = () => {
    pipe.proc = spawn(
      ffmpegBin,
      [
        "-y",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
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
        videoPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    if (pipe.proc) getRuntime(job.id).procs.push(pipe.proc);
    pipe.stdin = pipe.proc.stdin;
    pipe.proc.stderr?.on("data", (d: Buffer) => {
      pipe.err += d.toString();
      if (pipe.err.length > 8000) pipe.err = pipe.err.slice(-4000);
    });
    const proc = pipe.proc;
    pipe.done = new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg encode failed (${code}): ${pipe.err.slice(-800)}`));
      });
    });
  };

  const bgMeta = job.payload.backgroundFrames;
  const backgroundFrames =
    bgMeta && bgMeta.count > 0
      ? {
          ...bgMeta,
          urls: Array.from({ length: bgMeta.count }, (_, i) =>
            path.join(dir, "bg-frames", `f${String(i + 1).padStart(4, "0")}.png`),
          ),
        }
      : undefined;

  const recordingVideos = (job.payload.recordingVideos ?? []).map((rv, videoIndex) => ({
    mediaUrl: rv.mediaUrl,
    fps: rv.fps,
    durationMs: rv.durationMs,
    urls: Array.from({ length: rv.count }, (_, i) =>
      path.join(
        dir,
        "rec-frames",
        String(videoIndex),
        `f${String(i + 1).padStart(4, "0")}.png`,
      ),
    ),
  }));

  const scenes = (job.payload.scenes ?? []) as Scene[];
  const timelineMs = masterTimelineDurationMs(scenes);
  const renderTimeoutMs = job.payload.audioOnly
    ? 10 * 60_000
    : exportRenderTimeoutMs(timelineMs, job.payload.quality);
  const timeoutMin = Math.round(renderTimeoutMs / 60_000);
  job.stage = job.payload.audioOnly
    ? "rebuilding narration (video cached)…"
    : `rendering frames (hybrid, up to ~${timeoutMin} min)…`;
  writeJobMeta(job, true);

  const ac = new AbortController();
  const cancelTimer = setInterval(() => {
    if (job.cancelRequested || job.status === "cancelled") {
      ac.abort();
    }
  }, 400);
  const timeoutTimer = setTimeout(() => ac.abort(), renderTimeoutMs);

  try {
    const result = await Promise.race([
      rasterizeExportFramesHybrid({
        scenes,
        masterAudioUrl: job.payload.masterAudioUrl,
        quality: job.payload.quality,
        background: job.payload.background,
        bgm: job.payload.bgm,
        backgroundFrames,
        recordingVideos: recordingVideos.length > 0 ? recordingVideos : undefined,
        audioOnly: job.payload.audioOnly === true,
        signal: ac.signal,
        baseUrl: job.baseUrl,
        onProgress: (stage, ratio) => {
          throwIfCancelled(job);
          job.stage = stage;
          job.progress = Math.min(0.92, Math.max(job.progress, ratio));
          writeJobMeta(job);
        },
        onFrame: async (png, frameIndex, totalFrames) => {
          throwIfCancelled(job);
          if (pipe.finished || job.payload.audioOnly) return;

          if (frameIndex === 0 && pipe.frames > 0) {
            resetFfmpegPipe();
          }

          if (pipe.expectedTotalFrames == null) {
            pipe.expectedTotalFrames = totalFrames;
          } else if (pipe.expectedTotalFrames !== totalFrames) {
            throw new Error(
              `Export frame stream changed length (${pipe.expectedTotalFrames} → ${totalFrames})`,
            );
          }

          if (frameIndex < 0 || frameIndex >= totalFrames) {
            throw new Error(`Export frame index out of range: ${frameIndex}/${totalFrames}`);
          }

          if (frameIndex !== pipe.frames) {
            throw new Error(
              `Export frame out of order: expected index ${pipe.frames}, got ${frameIndex}`,
            );
          }

          await enqueueFrameWrite(async () => {
            if (pipe.finished) return;
            if (!pipe.stdin) startFfmpegPipe();
            const stdin = pipe.stdin;
            if (!stdin) throw new Error("ffmpeg stdin missing");
            if (!stdin.write(Buffer.from(png))) {
              await new Promise<void>((r) => stdin.once("drain", r));
            }
            pipe.frames += 1;
          });
        },
      }),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener("abort", () => {
          reject(
            new Error(
              job.cancelRequested || job.status === "cancelled"
                ? "Export stopped by user"
                : job.payload.audioOnly
                  ? "Audio rebuild timed out. Try a full export again."
                  : `Export timed out (${timeoutMin} min). For long HD (1080p30) parts try 720p first, or run HD again — timeout now scales with length.`,
            ),
          );
        });
      }),
    ]);

    pipe.finished = true;
    pipe.expectedTotalMs = result.totalMs;
    job.totalMs = result.totalMs;
    job.totalFrames = result.totalFrames;
    job.sceneCount = job.payload.scenes.length;
    writeJobMeta(job, true);

    if (result.audioBlob) {
      writeFileSync(audioPath, Buffer.from(await result.audioBlob.arrayBuffer()));
      pipe.audio = true;
    }

    if (!job.payload.audioOnly) {
      await pipe.writeChain;
      if (pipe.expectedTotalFrames != null && pipe.frames !== pipe.expectedTotalFrames) {
        throw new Error(
          `Export produced ${pipe.frames} frames, expected ${pipe.expectedTotalFrames} (${(result.totalMs / 1000).toFixed(2)}s)`,
        );
      }
      if (pipe.stdin) {
        pipe.stdin.end();
        pipe.stdin = null;
      }
      if (pipe.done) {
        job.stage = "encoding video…";
        job.progress = 0.93;
        writeJobMeta(job, true);
        await pipe.done;
      } else if (pipe.frames === 0 && result.totalFrames > 0) {
        throw new Error("Export produced no frames");
      }

      if (existsSync(videoPath)) {
        try {
          writeCachedSilentVideo(videoHash, videoPath);
        } catch (e) {
          console.warn("[export] silent video cache write failed", e);
        }
      }
    }

    const needsNarration =
      job.payload.scenes.length > 1 || !!job.payload.masterAudioUrl;
    if (pipe.audio && existsSync(audioPath)) {
      job.stage = "muxing audio…";
      job.progress = 0.96;
      writeJobMeta(job, true);
      const muxArgs = [
        "-y",
        "-i",
        videoPath,
        "-i",
        audioPath,
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
        "-movflags",
        "+faststart",
      ];
      if (result.totalMs > 0) {
        muxArgs.push("-t", String(result.totalMs / 1000));
      } else {
        muxArgs.push("-shortest");
      }
      muxArgs.push(finalPath);
      await runFfmpeg(ffmpegBin, muxArgs);
      if (!job.payload.audioOnly) {
        try {
          await unlink(videoPath);
        } catch {
          /* ignore */
        }
      }
    } else if (needsNarration) {
      throw new Error(
        "Export finished without narration audio. Stitch + Save part, sync project-assets if on another Mac, then export again.",
      );
    } else {
      const { renameSync } = await import("node:fs");
      renameSync(videoPath, finalPath);
    }

    try {
      await unlink(audioPath);
    } catch {
      /* ignore */
    }

    throwIfCancelled(job);
    job.outputPath = finalPath;
    job.status = "done";
    job.stage = job.payload.audioOnly ? "done (audio remux)" : "done";
    job.progress = 1;
    writeJobMeta(job, true);

    try {
      writeCachedFinal(videoHash, audioHash, finalPath);
    } catch (e) {
      console.warn("[export] final cache write failed", e);
    }

    try {
      const { useSpaces } = await import("@/lib/runtime-backends");
      if (useSpaces() && existsSync(finalPath)) {
        const { putAsset } = await import("@/lib/object-storage");
        const { readFileSync: readFs } = await import("node:fs");
        await putAsset({
          kind: "project",
          relPath: path.posix.join("_exports", job.id, path.basename(finalPath)),
          body: readFs(finalPath),
          contentType: "video/mp4",
        });
      }
    } catch (e) {
      console.warn("[export] Spaces mirror of MP4 failed (local file still kept)", e);
    }
  } finally {
    clearInterval(cancelTimer);
    clearTimeout(timeoutTimer);
    clearRuntime(job.id);
  }
}

export function readJobPayload(jobId: string, token: string): ExportJobPayload {
  const job = jobs.get(jobId);
  if (job) {
    if (job.token !== token) throw new Error("Invalid export token");
    return job.payload;
  }
  const dir = jobDir(jobId);
  const payloadPath = path.join(dir, "payload.json");
  const tokenPath = path.join(dir, "token.txt");
  if (!existsSync(payloadPath) || !existsSync(tokenPath)) {
    throw new Error("Export job not found");
  }
  if (readFileSync(tokenPath, "utf8").trim() !== token) {
    throw new Error("Invalid export token");
  }
  return JSON.parse(readFileSync(payloadPath, "utf8")) as ExportJobPayload;
}
