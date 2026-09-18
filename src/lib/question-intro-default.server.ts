import { QUESTION_INTRO_SCREEN_TEXT_DEFAULT, isDefaultIntroText } from "@/lib/question-scene-layout";
import { ensureDefaultVoiceAsset } from "@/lib/default-voice-assets.server";
import { legacyDefaultAudioUrl } from "@/lib/default-voice-assets";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

export function defaultIntroTtsUrl(): string {
  return legacyDefaultAudioUrl("question-intro");
}

export async function ensureDefaultIntroTts(courseId?: string | null) {
  const r = await ensureDefaultVoiceAsset("question-intro", courseId);
  return { audioUrl: r.audioUrl, text: r.text, cached: r.cached };
}

export async function generateIntroTts(text: string, courseId?: string | null) {
  const trimmed = text.trim();
  if (isDefaultIntroText(trimmed)) return ensureDefaultIntroTts(courseId);
  const buf = await generateTtsMp3Buffer(trimmed, { courseId });
  return {
    audioUrl: `data:audio/mpeg;base64,${buf.toString("base64")}`,
    text: trimmed,
    cached: false,
  };
}

export { QUESTION_INTRO_SCREEN_TEXT_DEFAULT };
