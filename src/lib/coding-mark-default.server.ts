import { assetExists, putAsset } from "@/lib/object-storage";
import {
  CODING_MARK_SCREEN_TEXT_DEFAULT,
  isDefaultCodingMarkText,
} from "@/lib/question-scene-layout";
import { normalizeNarrationText } from "@/lib/narration-text";

const DEFAULT_FILENAME = "coding-mark-default.mp3";

export function defaultCodingMarkTtsUrl(): string {
  return `/api/app-assets/${DEFAULT_FILENAME}`;
}

async function synthesizeMp3(rawText: string): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY missing");

  const text = normalizeNarrationText(rawText);
  const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID ?? "TX3LPaxmHKxFdv7VOQHJ";
  const ELEVEN_MODEL = process.env.ELEVEN_MODEL ?? "eleven_v3";

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text.replace(/[.!?…]*\s*$/, "") + " ... ",
        model_id: ELEVEN_MODEL,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.5,
          use_speaker_boost: true,
        },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Coding mark TTS failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function writeDefaultFile(buf: Buffer): Promise<string> {
  await putAsset({
    kind: "app",
    relPath: DEFAULT_FILENAME,
    body: buf,
    contentType: "audio/mpeg",
  });
  return defaultCodingMarkTtsUrl();
}

/** Generate once and cache under .data/app-assets/. */
export async function ensureDefaultCodingMarkTts() {
  const url = defaultCodingMarkTtsUrl();
  if ((await assetExists("app", DEFAULT_FILENAME))) {
    return { audioUrl: url, text: CODING_MARK_SCREEN_TEXT_DEFAULT, cached: true };
  }
  const buf = await synthesizeMp3(CODING_MARK_SCREEN_TEXT_DEFAULT);
  await writeDefaultFile(buf);
  return { audioUrl: url, text: CODING_MARK_SCREEN_TEXT_DEFAULT, cached: false };
}

export async function generateCodingMarkTts(text: string) {
  const trimmed = text.trim();
  if (isDefaultCodingMarkText(trimmed) && (await assetExists("app", DEFAULT_FILENAME))) {
    return {
      audioUrl: defaultCodingMarkTtsUrl(),
      text: CODING_MARK_SCREEN_TEXT_DEFAULT,
      cached: true,
    };
  }
  if (isDefaultCodingMarkText(trimmed)) {
    const buf = await synthesizeMp3(CODING_MARK_SCREEN_TEXT_DEFAULT);
    const url = await writeDefaultFile(buf);
    return { audioUrl: url, text: CODING_MARK_SCREEN_TEXT_DEFAULT, cached: false };
  }
  const buf = await synthesizeMp3(trimmed);
  return {
    audioUrl: `data:audio/mpeg;base64,${buf.toString("base64")}`,
    text: trimmed,
    cached: false,
  };
}
