import {
  getStoredSessionToken,
  handleExpiredSession,
  SESSION_EXPIRED_MESSAGE,
} from "@/lib/auth-client";

export type RenderJobStatus =
  | "queued"
  | "rendering"
  | "done"
  | "failed"
  | "cancelled";

export type RenderJobItem = {
  id: string;
  courseId: string | null;
  projectId: string;
  partId: string;
  episodeTitle: string;
  partTitle: string;
  requestedByUserId: string;
  requestedByEmail: string;
  durationMs: number;
  sceneCount: number;
  status: RenderJobStatus;
  progress: number;
  stage: string;
  machine: string | null;
  createdAt: string;
  claimedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  outputUrl: string | null;
  error: string | null;
};

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");
  const res = await fetch("/api/render-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    handleExpiredSession();
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }
  const raw = await res.text();
  let data: (T & { error?: string }) | null = null;
  try {
    data = JSON.parse(raw) as T & { error?: string };
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new Error(data?.error || raw.slice(0, 300) || "Request failed");
  if (!data) throw new Error("Invalid response");
  return data;
}

export function apiQueueRender(
  projectId: string,
  partId: string,
): Promise<{ job: RenderJobItem }> {
  return call({ action: "queue", projectId, partId });
}

export function apiListRenderJobs(opts?: {
  courseId?: string;
}): Promise<{ jobs: RenderJobItem[] }> {
  return call({ action: "list", courseId: opts?.courseId });
}

export function apiStopRenderJob(id: string): Promise<{ ok: true }> {
  return call({ action: "stop", id });
}

export function apiDeleteRenderJob(id: string): Promise<{ ok: true }> {
  return call({ action: "delete", id });
}

/** Admin only — removes the rendered MP4 and its link, keeps the job row. */
export function apiDeleteRenderVideo(id: string): Promise<{ ok: true }> {
  return call({ action: "delete-video", id });
}

export function apiRequeueRenderJob(id: string): Promise<{ job: RenderJobItem }> {
  return call({ action: "requeue", id });
}
