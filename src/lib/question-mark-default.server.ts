import { QUESTION_MARK_SCREEN_TEXT_DEFAULT, isDefaultMarkText } from "@/lib/question-scene-layout";
import { ensureDefaultVoiceAsset } from "@/lib/default-voice-assets.server";
import { legacyDefaultAudioUrl } from "@/lib/default-voice-assets";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

export function defaultMarkTtsUrl(): string {
  return legacyDefaultAudioUrl("question-mark");
}

export async function ensureDefaultMarkTts(courseId?: string | null) {
  const r = await ensureDefaultVoiceAsset("question-mark", courseId);
  return { audioUrl: r.audioUrl, text: r.text, cached: r.cached };
}

export async function generateMarkTts(text: string, courseId?: string | null) {
  const trimmed = text.trim();
  if (isDefaultMarkText(trimmed)) return ensureDefaultMarkTts(courseId);
  const buf = await generateTtsMp3Buffer(trimmed, { courseId });
  return {
    audioUrl: `data:audio/mpeg;base64,${buf.toString("base64")}`,
    text: trimmed,
    cached: false,
  };
}

export { QUESTION_MARK_SCREEN_TEXT_DEFAULT };
