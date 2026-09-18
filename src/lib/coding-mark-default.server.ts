import { CODING_MARK_SCREEN_TEXT_DEFAULT, isDefaultCodingMarkText } from "@/lib/question-scene-layout";
import { ensureDefaultVoiceAsset } from "@/lib/default-voice-assets.server";
import { legacyDefaultAudioUrl } from "@/lib/default-voice-assets";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

export function defaultCodingMarkTtsUrl(): string {
  return legacyDefaultAudioUrl("coding-mark");
}

export async function ensureDefaultCodingMarkTts(courseId?: string | null) {
  const r = await ensureDefaultVoiceAsset("coding-mark", courseId);
  return { audioUrl: r.audioUrl, text: r.text, cached: r.cached };
}

export async function generateCodingMarkTts(text: string, courseId?: string | null) {
  const trimmed = text.trim();
  if (isDefaultCodingMarkText(trimmed)) return ensureDefaultCodingMarkTts(courseId);
  const buf = await generateTtsMp3Buffer(trimmed, { courseId });
  return {
    audioUrl: `data:audio/mpeg;base64,${buf.toString("base64")}`,
    text: trimmed,
    cached: false,
  };
}

export { CODING_MARK_SCREEN_TEXT_DEFAULT };
