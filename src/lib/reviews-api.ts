import { getStoredSessionToken } from "@/lib/auth-client";

export type EpisodeReview = {
  project_id: string;
  course_id: string | null;
  parts_checked: string;
  review_status: string;
  issues_found: string;
  correction_status: string;
  assignee_email: string;
  rendered_uploaded: string;
  updated_by_email: string | null;
  updated_at: string;
};

export type EpisodeReviewPatch = {
  projectId: string;
  courseId?: string | null;
  parts_checked?: string;
  review_status?: string;
  issues_found?: string;
  correction_status?: string;
  assignee_email?: string;
  rendered_uploaded?: string;
};

async function reviewsFetch<T>(body: Record<string, unknown>): Promise<T> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");
  const res = await fetch("/api/reviews", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data: (T & { error?: string }) | null = null;
  try {
    data = JSON.parse(raw) as T & { error?: string };
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    throw new Error(
      (data && data.error) || raw.slice(0, 300) || "Reviews request failed",
    );
  }
  if (!data) throw new Error(raw.slice(0, 300) || "Reviews response invalid");
  return data;
}

export function apiListReviews(courseId: string): Promise<EpisodeReview[]> {
  return reviewsFetch({ action: "list", courseId });
}

export function apiSaveReview(patch: EpisodeReviewPatch): Promise<EpisodeReview> {
  return reviewsFetch({ action: "save", ...patch });
}
