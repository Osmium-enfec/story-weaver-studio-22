/**
 * Client for the local Explainer Render Agent (Mac app on :3850).
 * Studio prefers this for HD/720 so encode runs on the user's machine.
 */
import type { Scene } from "@/components/VideoPlayer";
import type { ExportQuality } from "@/lib/export-rasterize";
import type { PartBgmConfig } from "@/lib/part-bgm";
import type { SceneBackground } from "@/lib/scene-background";
import type { ExportJobStatusRow } from "@/lib/native-export-client";
import { downloadBlob } from "@/lib/ffmpeg-stitcher";

export const RENDER_AGENT_BASE =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: { VITE_RENDER_AGENT_URL?: string } }).env
      ?.VITE_RENDER_AGENT_URL) ||
  "http://127.0.0.1:3850";

/** 3850 = stable/live encode. 3851 = isolated crash-proof worker. */
const AGENT_CANDIDATES = ["http://127.0.0.1:3850", "http://127.0.0.1:3851"] as const;

let cachedAgentBase = "";

async function pingAgent(
  base: string,
  timeoutMs: number,
): Promise<{ isolated: boolean } | null> {
  try {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${base}/api/health`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    window.clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; isolated?: boolean };
    if (data.ok !== true) return null;
    return { isolated: data.isolated === true };
  } catch {
    return null;
  }
}

async function agentHasActiveJob(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/jobs`, { cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as { jobs?: Array<{ status?: string }> };
    return (data.jobs ?? []).some(
      (j) => j.status === "running" || j.status === "queued",
    );
  } catch {
    return false;
  }
}

/** Pick 3850 if it is encoding; otherwise prefer the isolated worker on 3851. */
export async function resolveRenderAgentBase(
  timeoutMs = 900,
): Promise<string | null> {
  const envBase = RENDER_AGENT_BASE;
  if (envBase && !AGENT_CANDIDATES.includes(envBase as (typeof AGENT_CANDIDATES)[number])) {
    const hit = await pingAgent(envBase, timeoutMs);
    if (hit) {
      cachedAgentBase = envBase;
      return envBase;
    }
  }

  const found: { base: string; isolated: boolean }[] = [];
  for (const base of AGENT_CANDIDATES) {
    const hit = await pingAgent(base, timeoutMs);
    if (hit) found.push({ base, isolated: hit.isolated });
  }
  if (!found.length) {
    cachedAgentBase = "";
    return null;
  }

  const stable = found.find((f) => f.base.endsWith(":3850"));
  const isolated = found.find((f) => f.isolated);
  if (stable && (await agentHasActiveJob(stable.base))) {
    cachedAgentBase = stable.base;
    return stable.base;
  }
  const picked = isolated?.base || stable?.base || found[0]!.base;
  cachedAgentBase = picked;
  return picked;
}

function agentBase(): string {
  return cachedAgentBase || RENDER_AGENT_BASE;
}

const AGENT_JOBS_KEY = "explainer.renderAgentJobIds";

type AgentJob = {
  id: string;
  status: ExportJobStatusRow["status"];
  progress: number;
  stage: string;
  filename: string;
  quality?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
  downloadReady?: boolean;
};

function rememberAgentJobId(id: string) {
  try {
    const raw = sessionStorage.getItem(AGENT_JOBS_KEY);
    const list: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (!list.includes(id)) {
      list.unshift(id);
      sessionStorage.setItem(AGENT_JOBS_KEY, JSON.stringify(list.slice(0, 40)));
    }
  } catch {
    /* ignore */
  }
}

export function rememberedAgentJobIds(): string[] {
  try {
    const raw = sessionStorage.getItem(AGENT_JOBS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** Rewrite relative /api/… asset URLs so the agent can fetch them from Studio. */
export function absolutizeExportPayload<T>(value: T, origin: string): T {
  const o = origin.replace(/\/$/, "");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith("/") && !v.startsWith("//")) {
        return `${o}${v}`;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export async function probeRenderAgent(timeoutMs = 900): Promise<boolean> {
  return (await resolveRenderAgentBase(timeoutMs)) != null;
}

export async function startRenderAgentJob(opts: {
  scenes: Scene[];
  masterAudioUrl?: string;
  quality: ExportQuality;
  background?: SceneBackground;
  bgm?: PartBgmConfig | null;
  filename?: string;
  studioUrl?: string;
  authToken?: string;
}): Promise<{ jobId: string }> {
  const origin =
    opts.studioUrl?.replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "");

  const payload = absolutizeExportPayload(
    {
      scenes: opts.scenes,
      masterAudioUrl: opts.masterAudioUrl,
      quality: opts.quality,
      background: opts.background,
      bgm: opts.bgm ?? null,
      filename:
        opts.filename ||
        `explainer-${opts.quality === "hd" ? "1080p" : "720p"}-${Date.now()}.mp4`,
    },
    origin,
  );

  const base = (await resolveRenderAgentBase()) || RENDER_AGENT_BASE;
  const res = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      studioUrl: origin,
      filename: payload.filename,
      quality: payload.quality,
      authToken: opts.authToken,
      payload,
    }),
  });
  const data = (await res.json()) as { jobId?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Render Agent rejected the job");
  if (!data.jobId) throw new Error("Render Agent did not return a job id");
  rememberAgentJobId(data.jobId);
  return { jobId: data.jobId };
}

function mapAgentJob(j: AgentJob): ExportJobStatusRow {
  return {
    jobId: j.id,
    status: j.status,
    stage: j.stage || "",
    progress: j.progress ?? 0,
    error: j.error,
    filename: j.filename || "export.mp4",
    quality: (j.quality as ExportQuality | undefined) ?? undefined,
    createdAt: j.createdAt,
    runner: "agent",
  };
}

export async function listRenderAgentJobs(): Promise<ExportJobStatusRow[]> {
  const base = (await resolveRenderAgentBase()) || RENDER_AGENT_BASE;
  const res = await fetch(`${base}/api/jobs`, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to list Render Agent jobs");
  const data = (await res.json()) as { jobs?: AgentJob[] };
  return (data.jobs ?? []).map(mapAgentJob);
}

export async function fetchRenderAgentJobStatus(
  jobId: string,
): Promise<ExportJobStatusRow> {
  const res = await fetch(`${agentBase()}/api/jobs/${encodeURIComponent(jobId)}`, {
    cache: "no-store",
  });
  const data = (await res.json()) as { job?: AgentJob; error?: string };
  if (!res.ok || !data.job) throw new Error(data.error ?? "Agent job not found");
  return mapAgentJob(data.job);
}

export async function downloadRenderAgentJob(
  jobId: string,
  filename: string,
): Promise<void> {
  const res = await fetch(
    `${agentBase()}/api/jobs/${encodeURIComponent(jobId)}/download`,
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "Agent download failed");
  }
  downloadBlob(await res.blob(), filename);
}

export async function deleteRenderAgentJob(jobId: string): Promise<void> {
  const res = await fetch(
    `${agentBase()}/api/jobs/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "Agent delete failed");
  }
}

export async function resumeRenderAgentJob(jobId: string): Promise<void> {
  const base = (await resolveRenderAgentBase()) || RENDER_AGENT_BASE;
  const res = await fetch(
    `${base}/api/jobs/${encodeURIComponent(jobId)}/resume`,
    { method: "POST" },
  );
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Agent resume failed");
}
