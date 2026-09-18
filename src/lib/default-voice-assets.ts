/**
 * Built-in narration clips ("Now test your understanding", "Mark your answers",
 * the coding-question intros and the fixed template cards).
 *
 * These are shared across every course, so the audio file is cached per voice
 * engine, and scenes point at a course-scoped URL:
 *
 *   /api/app-assets/course/<courseId>/question-intro-default.mp3
 *
 * The server resolves the course's current voice at request time, so changing
 * the voice in Course settings changes these clips everywhere with no
 * regeneration of existing scenes.
 */
import type { VoiceEngine } from "@/lib/course-voice";

export type DefaultVoiceAssetSlug =
  | "question-intro"
  | "question-mark"
  | "coding-intro"
  | "coding-mark"
  | "try-question"
  | "try-coding";

/** Stable (legacy) filename per clip — also the course-scoped URL's last segment. */
export const DEFAULT_VOICE_ASSET_FILES: Record<DefaultVoiceAssetSlug, string> = {
  "question-intro": "question-intro-default.mp3",
  "question-mark": "question-mark-default.mp3",
  "coding-intro": "coding-intro-default.mp3",
  "coding-mark": "coding-mark-default.mp3",
  "try-question": "template-try-question-default.mp3",
  "try-coding": "template-try-coding-default.mp3",
};

export const DEFAULT_VOICE_ASSET_SLUGS = Object.keys(
  DEFAULT_VOICE_ASSET_FILES,
) as DefaultVoiceAssetSlug[];

/** Cached file for one clip in one voice, e.g. question-intro-default-kokoro.mp3 */
export function engineAssetFilename(
  slug: DefaultVoiceAssetSlug,
  engine: VoiceEngine,
): string {
  return DEFAULT_VOICE_ASSET_FILES[slug].replace(/\.mp3$/, `-${engine}.mp3`);
}

export function legacyDefaultAudioUrl(slug: DefaultVoiceAssetSlug): string {
  return `/api/app-assets/${DEFAULT_VOICE_ASSET_FILES[slug]}`;
}

export function courseDefaultAudioUrl(
  slug: DefaultVoiceAssetSlug,
  courseId: string,
): string {
  return `/api/app-assets/course/${encodeURIComponent(courseId)}/${DEFAULT_VOICE_ASSET_FILES[slug]}`;
}

export function slugForDefaultFilename(
  filename: string,
): DefaultVoiceAssetSlug | null {
  for (const slug of DEFAULT_VOICE_ASSET_SLUGS) {
    if (DEFAULT_VOICE_ASSET_FILES[slug] === filename) return slug;
  }
  return null;
}

/**
 * Rewrite legacy (voice-less) default clip URLs stored in old scenes to the
 * course-scoped URL, so they follow the course's current voice setting.
 */
export function upgradeDefaultVoiceUrls<T>(value: T, courseId: string | null): T {
  if (!courseId) return value;
  const rewrite = (text: string): string => {
    let out = text;
    for (const slug of DEFAULT_VOICE_ASSET_SLUGS) {
      const file = DEFAULT_VOICE_ASSET_FILES[slug];
      out = out.split(`/api/app-assets/${file}`).join(courseDefaultAudioUrl(slug, courseId));
    }
    return out;
  };

  if (typeof value === "string") {
    return (value.includes("/api/app-assets/") ? rewrite(value) : value) as T;
  }
  if (value == null || typeof value !== "object") return value;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return value;
  }
  if (!json.includes("/api/app-assets/")) return value;
  try {
    return JSON.parse(rewrite(json)) as T;
  } catch {
    return value;
  }
}
