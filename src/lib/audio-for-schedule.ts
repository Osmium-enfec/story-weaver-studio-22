import type { SttWord } from "./audio-slice";
import { normalizeElevenLabsWords } from "./script-stt-sync";

export interface TranscribeResult {
  words: SttWord[];
  durationSec?: number;
}

/** Transcribe scene audio in the browser via /api/transcribe (ElevenLabs Scribe). */
export async function transcribeSceneAudioClient(url: string): Promise<SttWord[]> {
  const result = await transcribeSceneAudioDetailed(url);
  return result.words;
}

/** Full ElevenLabs transcript with word timestamps for reveal sync. */
export async function transcribeSceneAudioDetailed(url: string): Promise<TranscribeResult> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { words: [] };
    const blob = await res.blob();
    const form = new FormData();
    const ext = blob.type.includes("wav") ? "clip.wav" : "clip.mp3";
    form.append("file", blob, ext);
    const tr = await fetch("/api/transcribe", { method: "POST", body: form });
    if (!tr.ok) return { words: [] };
    const j = await tr.json();
    const raw: unknown[] = Array.isArray(j.words)
      ? j.words
      : Array.isArray(j?.transcription?.words)
        ? j.transcription.words
        : [];
    const words = normalizeElevenLabsWords(raw);
    const durationSec =
      typeof j.audio_duration_secs === "number"
        ? j.audio_duration_secs
        : words.length
          ? words[words.length - 1]!.end
          : undefined;
    return { words, durationSec };
  } catch {
    return { words: [] };
  }
}
