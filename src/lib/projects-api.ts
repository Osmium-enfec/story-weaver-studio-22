import { getStoredSessionToken } from "@/lib/auth-client";

/** Episode list card (legacy name: project). */
export type ProjectListItem = {
  id: string;
  title: string;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
  audio_mode: string;
  scene_count: number;
  part_count?: number;
  course_id?: string | null;
  assigned_user_id?: string | null;
  assigned_user_email?: string | null;
  part_assignee_emails?: string[];
  parts_summary?: ProjectPartSummary[];
};

export type ProjectPartSummary = {
  id: string;
  title: string;
  assigned_user_id: string | null;
  assigned_user_email: string | null;
  scene_count: number;
};


/** A full episode row as returned by POST /api/projects { action: "get" }. */
export type ProjectRecord = {
  id: string;
  title: string;
  script?: string | null;
  audio_mode: string;
  thumbnail_url?: string | null;
  scenes?: unknown;
  parts?: unknown;
  workshop_draft?: unknown;
  course_id?: string | null;
  assigned_user_id?: string | null;
  assigned_user_email?: string | null;
  created_at: string;
  updated_at: string;
};

async function projectsFetch<T>(
  body: Record<string, unknown>,
): Promise<T> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");

  const res = await fetch("/api/projects", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  // When Cloudflare/LB returns an HTML error page (502/etc), `res.json()`
  // throws: "Unexpected token '<', ... is not valid JSON" and breaks the UI.
  // We instead read as text and only JSON-parse when possible.
  const raw = await res.text();
  let data: (T & { error?: string }) | null = null;
  try {
    data = JSON.parse(raw) as T & { error?: string };
  } catch {
    // non-JSON (likely HTML error page)
  }

  if (!res.ok) {
    const msg =
      (data && (data as any).error) ||
      (raw ? raw.slice(0, 300) : "") ||
      "Projects request failed";
    throw new Error(msg);
  }

  if (!data) throw new Error(raw.slice(0, 300) || "Projects response invalid");
  return data;
}

export function apiListProjects(opts?: {
  courseId?: string | null;
}): Promise<ProjectListItem[]> {
  if (opts && "courseId" in opts) {
    return projectsFetch({ action: "list", course_id: opts.courseId ?? null });
  }
  return projectsFetch({ action: "list" });
}

export function apiGetProject(id: string): Promise<ProjectRecord> {
  return projectsFetch({ action: "get", id });
}

export function apiSaveProject(data: {
  id?: string;
  title: string;
  script?: string;
  audio_mode: "tts" | "upload";
  scenes: unknown;
  parts?: unknown;
  thumbnail_url?: string;
  workshop_draft?: unknown;
  course_id?: string | null;
  /** Only set true for intentional scene deletes. */
  allow_scene_shrink?: boolean;
  /** Script-only autosave: never overwrite newer scene media. */
  preserve_part_scenes?: boolean;
}): Promise<{ id: string; store: "sqlite" }> {
  return projectsFetch({ action: "save", ...data });
}

export function apiDeleteProject(id: string): Promise<{ ok: true }> {
  return projectsFetch({ action: "delete", id });
}

export function apiAssignEpisode(
  id: string,
  assignedUserId: string | null,
): Promise<ProjectRecord> {
  return projectsFetch({
    action: "assignEpisode",
    id,
    assigned_user_id: assignedUserId,
  });
}

export function apiAssignPart(
  episodeId: string,
  partId: string,
  assignedUserId: string | null,
): Promise<ProjectRecord> {
  return projectsFetch({
    action: "assignPart",
    id: episodeId,
    part_id: partId,
    assigned_user_id: assignedUserId,
  });
}

export function apiDeletePart(
  episodeId: string,
  partId: string,
): Promise<{ ok: true; partCount: number }> {
  return projectsFetch({ action: "deletePart", id: episodeId, part_id: partId });
}
