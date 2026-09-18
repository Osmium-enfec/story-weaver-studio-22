import { DEFAULT_VOICE_ENGINE, type VoiceEngine } from "@/lib/course-voice";
import { resolveCourseVoiceEngine } from "@/lib/course-settings";

/** Small in-process cache — course titles rarely change. */
const cache = new Map<string, { engine: VoiceEngine; at: number }>();
const TTL_MS = 5 * 60_000;

export function clearCourseVoiceCache(courseId?: string | null) {
  const id = (courseId ?? "").trim();
  if (id) cache.delete(id);
  else cache.clear();
}

export async function resolveVoiceEngineForCourse(
  courseId?: string | null,
): Promise<VoiceEngine> {
  const id = (courseId ?? "").trim();
  if (!id) return DEFAULT_VOICE_ENGINE;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.engine;

  try {
    const { localGetCourseById } = await import("@/lib/local-courses-db");
    const course = (await localGetCourseById(id)) as
      | { title?: string; settings?: unknown }
      | null;
    const { normalizeCourseSettings } = await import("@/lib/course-settings");
    const engine = resolveCourseVoiceEngine(
      course ? normalizeCourseSettings(course.settings) : null,
      course?.title ?? null,
    );
    cache.set(id, { engine, at: Date.now() });
    return engine;
  } catch (err) {
    console.warn("Could not resolve course voice, using default:", err);
    return DEFAULT_VOICE_ENGINE;
  }
}
