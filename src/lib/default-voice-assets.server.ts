import { assetExists, putAsset } from "@/lib/object-storage";
import { DEFAULT_VOICE_ENGINE, type VoiceEngine } from "@/lib/course-voice";
import {
  CODING_INTRO_SCREEN_TEXT_DEFAULT,
  CODING_MARK_SCREEN_TEXT_DEFAULT,
  QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
  QUESTION_MARK_SCREEN_TEXT_DEFAULT,
} from "@/lib/question-scene-layout";
import { FIXED_TEMPLATE_PRESETS } from "@/lib/template-fixed-presets";
import {
  courseDefaultAudioUrl,
  DEFAULT_VOICE_ASSET_SLUGS,
  engineAssetFilename,
  legacyDefaultAudioUrl,
  slugForDefaultFilename,
  type DefaultVoiceAssetSlug,
} from "@/lib/default-voice-assets";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

export function defaultVoiceAssetText(slug: DefaultVoiceAssetSlug): string {
  switch (slug) {
    case "question-intro":
      return QUESTION_INTRO_SCREEN_TEXT_DEFAULT;
    case "question-mark":
      return QUESTION_MARK_SCREEN_TEXT_DEFAULT;
    case "coding-intro":
      return CODING_INTRO_SCREEN_TEXT_DEFAULT;
    case "coding-mark":
      return CODING_MARK_SCREEN_TEXT_DEFAULT;
    case "try-question":
      return FIXED_TEMPLATE_PRESETS["try-question"].script;
    case "try-coding":
      return FIXED_TEMPLATE_PRESETS["try-coding"].script;
  }
}

async function resolveEngine(courseId?: string | null): Promise<VoiceEngine> {
  const id = (courseId ?? "").trim();
  if (!id) return DEFAULT_VOICE_ENGINE;
  const { resolveVoiceEngineForCourse } = await import("@/lib/course-voice.server");
  return resolveVoiceEngineForCourse(id);
}

/** Generate (once) and return the cached file name for one clip in one voice. */
export async function ensureDefaultVoiceAssetFile(
  slug: DefaultVoiceAssetSlug,
  engine: VoiceEngine,
): Promise<{ filename: string; cached: boolean }> {
  const filename = engineAssetFilename(slug, engine);
  if (await assetExists("app", filename)) return { filename, cached: true };
  const buf = await generateTtsMp3Buffer(defaultVoiceAssetText(slug), { engine });
  await putAsset({
    kind: "app",
    relPath: filename,
    body: buf,
    contentType: "audio/mpeg",
  });
  return { filename, cached: false };
}

/**
 * Clip URL for a course. Course-scoped URLs stay stable when the voice
 * changes — the serving route resolves the current voice per request.
 */
export async function ensureDefaultVoiceAsset(
  slug: DefaultVoiceAssetSlug,
  courseId?: string | null,
): Promise<{ audioUrl: string; text: string; cached: boolean; engine: VoiceEngine }> {
  const engine = await resolveEngine(courseId);
  const { cached } = await ensureDefaultVoiceAssetFile(slug, engine);
  const id = (courseId ?? "").trim();
  return {
    audioUrl: id ? courseDefaultAudioUrl(slug, id) : legacyDefaultAudioUrl(slug),
    text: defaultVoiceAssetText(slug),
    cached,
    engine,
  };
}

/**
 * Translate an `app` asset path into the real stored file.
 *
 * Handles both built-in clip forms:
 *   course/<courseId>/question-intro-default.mp3 → question-intro-default-<engine>.mp3
 *   question-intro-default.mp3                   → question-intro-default-<default engine>.mp3
 *
 * Any other path is returned unchanged. Returns null when the path looks like a
 * built-in clip reference but cannot be resolved.
 */
export async function resolveAppAssetRelPath(rel: string): Promise<string | null> {
  const parts = rel.split("/");
  if (parts[0] === "course") {
    const courseId = decodeURIComponent(parts[1] ?? "");
    const slug = slugForDefaultFilename(parts[2] ?? "");
    if (!courseId || !slug) return null;
    const engine = await resolveEngine(courseId);
    const { filename } = await ensureDefaultVoiceAssetFile(slug, engine);
    return filename;
  }
  if (parts.length === 1) {
    const slug = slugForDefaultFilename(parts[0]);
    if (slug) {
      const { filename } = await ensureDefaultVoiceAssetFile(slug, DEFAULT_VOICE_ENGINE);
      return filename;
    }
  }
  return rel;
}

/** Warm every built-in clip for one voice (called when a course voice changes). */
export async function ensureAllDefaultVoiceAssets(engine: VoiceEngine) {
  const results: { slug: DefaultVoiceAssetSlug; cached: boolean }[] = [];
  for (const slug of DEFAULT_VOICE_ASSET_SLUGS) {
    try {
      const r = await ensureDefaultVoiceAssetFile(slug, engine);
      results.push({ slug, cached: r.cached });
    } catch (err) {
      console.warn(`Could not pre-generate ${slug} in ${engine}:`, err);
    }
  }
  return results;
}
