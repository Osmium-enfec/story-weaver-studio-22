import { getStoredSessionToken } from "@/lib/auth-client";

export type RenderBundleItem = {
  id: string;
  projectId: string;
  partId: string;
  episodeTitle: string;
  partTitle: string;
  ownerEmail: string;
  durationMs: number;
  sceneCount: number;
  readyAt: string;
  status: "ready" | "rendering" | "done" | "failed";
  outputUrl: string | null;
  error: string | null;
};

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");
  const res = await fetch("/api/render-bundles", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
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

export function apiFreezeBundle(
  projectId: string,
  partId: string,
): Promise<{ bundle: RenderBundleItem }> {
  return call({ action: "freeze", projectId, partId });
}

export function apiListBundles(opts?: {
  all?: boolean;
}): Promise<{ bundles: RenderBundleItem[] }> {
  return call({ action: "list", all: opts?.all ?? false });
}

export function apiDeleteBundle(id: string): Promise<{ ok: true }> {
  return call({ action: "delete", id });
}
