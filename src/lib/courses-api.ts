import {
  getStoredSessionToken,
  handleExpiredSession,
  SESSION_EXPIRED_MESSAGE,
} from "@/lib/auth-client";
import type { CourseSettings } from "@/lib/course-settings";

export type CourseListItem = {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  settings: CourseSettings;
  created_at: string;
  updated_at: string;
  episode_count: number;
};

export type CourseRecord = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  settings: CourseSettings;
  created_at: string;
  updated_at: string;
};

async function coursesFetch<T>(body: Record<string, unknown>): Promise<T> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");

  const res = await fetch("/api/courses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    handleExpiredSession();
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Courses request failed");
  return data;
}

export function apiListCourses(): Promise<CourseListItem[]> {
  return coursesFetch({ action: "list" });
}

export function apiGetCourse(id: string): Promise<CourseRecord> {
  return coursesFetch({ action: "get", id });
}

export function apiSaveCourse(data: {
  id?: string;
  title: string;
  description?: string | null;
  thumbnail_url?: string;
  settings?: CourseSettings;
}): Promise<{ id: string; store: "sqlite" }> {
  return coursesFetch({ action: "save", ...data });
}

/** Update only the course theme (background, bumpers, voice). */
export async function apiSaveCourseSettings(
  course: { id: string; title: string; description?: string | null },
  settings: CourseSettings,
): Promise<void> {
  await apiSaveCourse({
    id: course.id,
    title: course.title,
    description: course.description ?? null,
    settings,
  });
}
