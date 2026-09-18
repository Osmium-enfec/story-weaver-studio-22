import { CODING_INTRO_SCREEN_TEXT_DEFAULT, isDefaultCodingIntroText } from "@/lib/question-scene-layout";
import { ensureDefaultVoiceAsset } from "@/lib/default-voice-assets.server";
import { legacyDefaultAudioUrl } from "@/lib/default-voice-assets";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

export function defaultCodingIntroTtsUrl(): string {
  return legacyDefaultAudioUrl("coding-intro");
}

export async function ensureDefaultCodingIntroTts(courseId?: string | null) {
  const r = await ensureDefaultVoiceAsset("coding-intro", courseId);
  return { audioUrl: r.audioUrl, text: r.text, cached: r.cached };
}

export async function generateCodingIntroTts(text: string, courseId?: string | null) {
  const trimmed = text.trim();
  if (isDefaultCodingIntroText(trimmed)) return ensureDefaultCodingIntroTts(courseId);
  const buf = await generateTtsMp3Buffer(trimmed, { courseId });
  return {
    audioUrl: `data:audio/mpeg;base64,${buf.toString("base64")}`,
    text: trimmed,
    cached: false,
  };
}

export { CODING_INTRO_SCREEN_TEXT_DEFAULT };
