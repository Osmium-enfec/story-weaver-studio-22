import type { Scene } from "@/components/VideoPlayer";
import { getStoredSessionToken } from "@/lib/auth-client";
import { apiPersistAsset } from "@/lib/compose-api";
import type { ExportQuality } from "@/lib/export-rasterize";
import { downloadBlob } from "@/lib/ffmpeg-stitcher";
import type { PartBgmConfig } from "@/lib/part-bgm";
import {
  isEphemeralAssetUrl,
  persistPartScenesForSave,
  persistScenesAssetsForSave,
} from "@/lib/persist-client-asset";
import type { SceneBackground } from "@/lib/scene-background";
import { healScenesForExport } from "@/lib/compose-scene";
import { stitchProjectScenes } from "@/lib/stitch-project-scenes";
import {
  probeRenderAgent,
  startRenderAgentJob,
} from "@/lib/render-agent-client";

export interface ExportJobStatusRow {
  jobId: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  stage: string;
  progress: number;
  error?: string;
  filename: string;
  quality?: ExportQuality;
  createdAt?: number;
  userId?: string;
  userEmail?: string;
  /** Local Mac Render Agent vs Studio server native export */
  runner?: "agent" | "server";
}

function authHeaders(): HeadersInit {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");
  return { Authorization: `Bearer ${token}` };
}

/** Infer project id from any already-persisted /api/assets/{user}/{project}/… URL. */
function inferProjectIdFromScenes(
  scenes: Scene[],
  masterAudioUrl?: string | null,
): string | null {
  const urls: string[] = [];
  if (masterAudioUrl) urls.push(masterAudioUrl);
  for (const s of scenes) {
    if (s.audioUrl) urls.push(s.audioUrl);
    if (s.masterAudioUrl) urls.push(s.masterAudioUrl);
    if (s.mediaUrl) urls.push(s.mediaUrl);
    if (s.backgroundUrl) urls.push(s.backgroundUrl);
    if (s.questionMarkAudioUrl) urls.push(s.questionMarkAudioUrl);
    if (s.questionIntroAudioUrl) urls.push(s.questionIntroAudioUrl);
    for (const el of s.elements ?? []) {
      if (el.mediaUrl) urls.push(el.mediaUrl);
    }
  }
  for (const u of urls) {
    const m = /\/api\/assets\/[^/]+\/([^/]+)\//.exec(u);
    if (m?.[1]) return m[1];
  }
  return null;
}

function sceneHasEphemeralMedia(scenes: Scene[], masterAudioUrl?: string | null): boolean {
  if (isEphemeralAssetUrl(masterAudioUrl)) return true;
  return scenes.some(
    (s) =>
      isEphemeralAssetUrl(s.audioUrl) ||
      isEphemeralAssetUrl(s.masterAudioUrl) ||
      isEphemeralAssetUrl(s.mediaUrl) ||
      isEphemeralAssetUrl(s.backgroundUrl) ||
      isEphemeralAssetUrl(s.compositeThumbUrl) ||
      isEphemeralAssetUrl(s.questionMarkAudioUrl) ||
      isEphemeralAssetUrl(s.questionIntroAudioUrl) ||
      (s.elements ?? []).some(
        (el) => isEphemeralAssetUrl(el.mediaUrl) || isEphemeralAssetUrl(el.sfxUrl),
      ),
  );
}

async function urlReachable(url: string | null | undefined): Promise<boolean> {
  if (!url || !String(url).trim()) return false;
  if (isEphemeralAssetUrl(url)) return false;
  try {
    const head = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (head.ok) return true;
    if (head.status === 405 || head.status === 501) {
      const get = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-1" },
        cache: "no-store",
      });
      return get.ok || get.status === 206;
    }
    return false;
  } catch {
    return false;
  }
}

function sceneLooksSilent(scene: Scene): boolean {
  if (scene.silentNarration) return true;
  if (scene.kind === "template" && scene.templateKind === "codeTyping") return true;
  return false;
}

/**
 * Ensure multi-scene exports have a durable, fetchable master narration track.
 * Rebuilds from scene audio when the saved master is missing on this machine.
 */
export async function ensureExportMasterAudio(opts: {
  scenes: Scene[];
  masterAudioUrl?: string | null;
  projectId?: string | null;
}): Promise<{ scenes: Scene[]; masterAudioUrl?: string }> {
  const scenesIn = healScenesForExport(opts.scenes);
  let master = opts.masterAudioUrl ?? scenesIn[0]?.masterAudioUrl ?? undefined;

  if (scenesIn.length <= 1) {
    const single = master || scenesIn[0]?.audioUrl || undefined;
    if (single && (await urlReachable(single))) {
      return { scenes: scenesIn, masterAudioUrl: single };
    }
    if (scenesIn[0] && sceneLooksSilent(scenesIn[0]) && !single) {
      return { scenes: scenesIn, masterAudioUrl: master };
    }
  }

  if (master && (await urlReachable(master))) {
    return {
      scenes: scenesIn.map((s) => ({ ...s, masterAudioUrl: master })),
      masterAudioUrl: master,
    };
  }

  const projectId =
    opts.projectId || inferProjectIdFromScenes(scenesIn, master) || null;
  if (!projectId) {
    throw new Error(
      "Narration audio is missing on this computer. Open the part, stitch, Save part, then export again. If you moved machines, sync .data/project-assets too.",
    );
  }

  const persist = (input: { url: string; projectId: string; ext: string }) =>
    apiPersistAsset(input);

  const durableScenes = await persistScenesAssetsForSave(scenesIn, projectId, persist);

  const needsVoice = durableScenes.some((s) => !sceneLooksSilent(s));
  if (needsVoice) {
    let ok = 0;
    for (const s of durableScenes) {
      if (sceneLooksSilent(s)) continue;
      if (s.audioUrl && (await urlReachable(s.audioUrl))) ok++;
    }
    if (ok === 0) {
      throw new Error(
        "Narration files are missing on this computer (broken /api/assets links). Sync .data/project-assets from the machine that recorded them (include collaborator folders), or re-generate voices, then stitch + Save part.",
      );
    }
  }

  const stitched = await stitchProjectScenes(durableScenes);
  const persisted = await persistPartScenesForSave(
    stitched.scenes,
    stitched.masterAudioUrl,
    projectId,
    persist,
  );

  if (!(await urlReachable(persisted.masterAudioUrl))) {
    throw new Error(
      "Rebuilt narration track could not be saved/read. Check disk space and try Save part again.",
    );
  }

  return {
    scenes: persisted.scenes,
    masterAudioUrl: persisted.masterAudioUrl,
  };
}

/**
 * Persist blob/data media to /api/assets so the export POST stays small.
 * Never base64-embed large audio in the export JSON (that OOMs Chrome).
 */
async function prepareScenesForExport(opts: {
  scenes: Scene[];
  masterAudioUrl?: string;
  projectId?: string | null;
}): Promise<{ scenes: Scene[]; masterAudioUrl?: string }> {
  const ensured = await ensureExportMasterAudio(opts);
  const projectId =
    opts.projectId ||
    inferProjectIdFromScenes(ensured.scenes, ensured.masterAudioUrl) ||
    null;

  const needsPersist = sceneHasEphemeralMedia(
    ensured.scenes,
    ensured.masterAudioUrl,
  );
  if (!needsPersist) {
    return ensured;
  }

  if (!projectId) {
    throw new Error(
      "Export needs a project to store audio/video locally. Save the part once, then download.",
    );
  }

  const persist = (input: { url: string; projectId: string; ext: string }) =>
    apiPersistAsset(input);

  const masterIn = ensured.masterAudioUrl ?? ensured.scenes[0]?.masterAudioUrl;
  if (masterIn) {
    const persisted = await persistPartScenesForSave(
      ensured.scenes,
      masterIn,
      projectId,
      persist,
    );
    return {
      scenes: persisted.scenes,
      masterAudioUrl: persisted.masterAudioUrl,
    };
  }

  const scenes = await persistScenesAssetsForSave(
    ensured.scenes,
    projectId,
    persist,
  );
  return { scenes, masterAudioUrl: scenes[0]?.masterAudioUrl };
}

/** Start a native export job; returns immediately with jobId (progress lives on /export).
 * Prefer agent / server / auto via `runner`.
 */
export async function startNativeExportJob(opts: {
  scenes: Scene[];
  masterAudioUrl?: string;
  quality: ExportQuality;
  background?: SceneBackground;
  bgm?: PartBgmConfig | null;
  filename?: string;
  /** When set, ephemeral blob/data media is saved to /api/assets before export. */
  projectId?: string | null;
  /**
   * Where to encode:
   * - `auto` (default): prefer local Render Agent, else Studio Mac
   * - `agent`: require local Render Agent (this Mac / collaborator Mac)
   * - `server`: Studio Mac native export
   */
  runner?: "auto" | "agent" | "server";
  /** @deprecated Use runner: "server" */
  preferServer?: boolean;
}): Promise<{ jobId: string; runner: "agent" | "server" }> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");

  const prepared = await prepareScenesForExport({
    scenes: opts.scenes,
    masterAudioUrl: opts.masterAudioUrl,
    projectId: opts.projectId,
  });

  const master = prepared.masterAudioUrl;
  if (prepared.scenes.length > 1 && !master) {
    throw new Error(
      "Cannot export: missing stitched narration. Stitch the part, click Save part, then export.",
    );
  }

  const scenes = prepared.scenes.map((s) =>
    master ? { ...s, masterAudioUrl: master } : s,
  );

  const filename =
    opts.filename ||
    `explainer-${opts.quality === "hd" ? "1080p" : "720p"}-${Date.now()}.mp4`;

  const mode: "auto" | "agent" | "server" =
    opts.runner ?? (opts.preferServer ? "server" : "auto");

  const tryAgent = mode === "auto" || mode === "agent";
  const forceServer = mode === "server";

  if (tryAgent && !forceServer) {
    const agentUp = await probeRenderAgent();
    if (mode === "agent" && !agentUp) {
      throw new Error(
        "Explainer Render Agent is not reachable on this Mac. Open the agent app (port 3850), update to the latest version if using deskos.app, or choose “Studio Mac”.",
      );
    }
    if (agentUp) {
      try {
        const { jobId } = await startRenderAgentJob({
          scenes,
          masterAudioUrl: master,
          quality: opts.quality,
          background: opts.background,
          bgm: opts.bgm ?? null,
          filename,
          studioUrl: typeof window !== "undefined" ? window.location.origin : undefined,
          authToken: token,
        });
        return { jobId, runner: "agent" };
      } catch (e) {
        if (mode === "agent") throw e;
        console.warn("[export] Render Agent failed; falling back to Studio server", e);
      }
    }
  }

  const startRes = await fetch("/api/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      scenes,
      masterAudioUrl: master,
      quality: opts.quality,
      background: opts.background,
      bgm: opts.bgm ?? null,
      filename,
    }),
  });
  const startData = (await startRes.json()) as { jobId?: string; error?: string };
  if (!startRes.ok) throw new Error(startData.error ?? "Failed to start export");
  if (!startData.jobId) throw new Error("Export job missing id");
  return { jobId: startData.jobId, runner: "server" };
}

export async function fetchExportJobStatus(jobId: string): Promise<ExportJobStatusRow> {
  const stRes = await fetch(`/api/export?jobId=${encodeURIComponent(jobId)}`, {
    headers: authHeaders(),
  });
  const st = (await stRes.json()) as ExportJobStatusRow & { error?: string };
  if (!stRes.ok) throw new Error(st.error ?? "Export status failed");
  return { ...st, jobId };
}

export async function listExportJobs(opts?: {
  allUsers?: boolean;
}): Promise<ExportJobStatusRow[]> {
  const q = opts?.allUsers ? "/api/export?list=1&all=1" : "/api/export?list=1";
  const res = await fetch(q, { headers: authHeaders() });
  const data = (await res.json()) as { jobs?: ExportJobStatusRow[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Failed to list exports");
  return data.jobs ?? [];
}

export async function downloadExportJob(jobId: string, filename: string): Promise<void> {
  const dl = await fetch(`/api/export?jobId=${encodeURIComponent(jobId)}&download=1`, {
    headers: authHeaders(),
  });
  if (!dl.ok) {
    const err = (await dl.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "Download failed");
  }
  const blob = await dl.blob();
  downloadBlob(blob, filename);
}

export async function deleteExportJob(jobId: string): Promise<void> {
  const res = await fetch(`/api/export?jobId=${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "Delete failed");
  }
}

export async function cancelExportJob(jobId: string): Promise<void> {
  const res = await fetch(
    `/api/export?jobId=${encodeURIComponent(jobId)}&stop=1`,
    {
      method: "DELETE",
      headers: authHeaders(),
    },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "Stop failed");
  }
}

export async function resumeNativeExportJob(jobId: string): Promise<void> {
  const res = await fetch(
    `/api/export?jobId=${encodeURIComponent(jobId)}&resume=1`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: "{}",
    },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "Resume failed");
  }
}

export { downloadBlob };
