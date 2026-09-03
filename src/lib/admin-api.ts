import { getStoredSessionToken } from "@/lib/auth-client";

export interface AdminOverview {
  summary: {
    userCount: number;
    courseCount: number;
    episodeCount: number;
    assignmentCount: number;
    exportJobCount: number;
    activeExports: number;
    savedSceneCount: number;
  };
  users: Array<{
    id: string;
    email: string;
    created_at: string;
    isAdmin: boolean;
    activeSessions: number;
    courseCount: number;
    episodeCount: number;
    assignmentCount: number;
    /** Compose scenes saved on parts assigned to this user. */
    savedSceneCount: number;
    exportJobsRunning: number;
  }>;
  courses: Array<{
    id: string;
    user_id: string;
    userEmail: string;
    title: string;
    description: string | null;
    thumbnail_url: string | null;
    created_at: string;
    updated_at: string;
    episode_count: number;
  }>;
  assignments: Array<{
    kind: "episode" | "part";
    episodeId: string;
    episodeTitle: string;
    courseId: string | null;
    partId?: string;
    partTitle?: string;
    assignedUserId: string;
    assignedUserEmail: string;
    sceneCount?: number;
    updated_at: string;
  }>;
  exports: Array<{
    jobId: string;
    status: string;
    stage: string;
    progress: number;
    error?: string;
    filename: string;
    quality: string;
    createdAt: number;
    userId: string;
    userEmail: string;
  }>;
}

export type AdminAssignUser = {
  id: string;
  email: string;
  created_at: string;
  isAdmin: boolean;
};

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");
  return fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function apiAdminOverview(): Promise<AdminOverview> {
  const res = await adminFetch("/api/admin");
  const data = (await res.json()) as AdminOverview & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Admin request failed");
  return data;
}

/** Fast user list for assign dropdowns — skips courses/exports. */
export async function apiAdminUsersOnly(): Promise<AdminAssignUser[]> {
  const res = await adminFetch("/api/admin?usersOnly=1");
  const data = (await res.json()) as { users?: AdminAssignUser[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Admin request failed");
  return data.users ?? [];
}

export async function apiAdminDeleteUser(userId: string): Promise<void> {
  const res = await adminFetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "deleteUser", userId }),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not delete user");
}

export type ReviewAccessUser = {
  id: string;
  email: string;
  isAdmin: boolean;
  fields: string[];
  /** True once an admin has saved an explicit grant (overrides implicit). */
  hasExplicit?: boolean;
  /** Access granted by built-in rules (reviewer role). */
  implicit?: string[];
};

export async function apiAdminReviewAccess(): Promise<ReviewAccessUser[]> {
  const res = await adminFetch("/api/admin?reviewAccess=1");
  const data = (await res.json()) as { users?: ReviewAccessUser[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Admin request failed");
  return data.users ?? [];
}

export async function apiAdminSetReviewAccess(
  email: string,
  fields: string[],
): Promise<string[]> {
  const res = await adminFetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "setReviewAccess", email, fields }),
  });
  const data = (await res.json()) as { fields?: string[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not save review access");
  return data.fields ?? [];
}
