import {
  DEFAULT_VOICE_ENGINE,
  voiceEngineForCourseName,
  type VoiceEngine,
} from "@/lib/course-voice";

/** Small in-process cache — course titles rarely change. */
const cache = new Map<string, { engine: VoiceEngine; at: number }>();
const TTL_MS = 5 * 60_000;

export async function resolveVoiceEngineForCourse(
  courseId?: string | null,
): Promise<VoiceEngine> {
  const id = (courseId ?? "").trim();
  if (!id) return DEFAULT_VOICE_ENGINE;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.engine;

  try {
    const { localGetCourseById } = await import("@/lib/local-courses-db");
    const course = (await localGetCourseById(id)) as { title?: string } | null;
    const engine = voiceEngineForCourseName(course?.title ?? null);
    cache.set(id, { engine, at: Date.now() });
    return engine;
  } catch (err) {
    console.warn("Could not resolve course voice, using default:", err);
    return DEFAULT_VOICE_ENGINE;
  }
}
