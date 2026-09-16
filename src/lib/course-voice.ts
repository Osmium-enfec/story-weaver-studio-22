/**
 * Which narration voice a course uses.
 *
 * - "Zero Code 2 AI Builder" (any "zero code" course) → Kokoro "Heart" voice
 * - Everything else (Python for AI, …)                → ElevenLabs "Liam"
 */
export type VoiceEngine = "elevenlabs" | "kokoro";

export const DEFAULT_VOICE_ENGINE: VoiceEngine = "elevenlabs";

export function voiceEngineForCourseName(name?: string | null): VoiceEngine {
  const n = (name ?? "").toLowerCase();
  if (/zero\s*-?\s*code/.test(n)) return "kokoro";
  return DEFAULT_VOICE_ENGINE;
}
