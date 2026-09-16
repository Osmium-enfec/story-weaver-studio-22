import { assetExists, putAsset } from "@/lib/object-storage";
import {
  CODING_INTRO_SCREEN_TEXT_DEFAULT,
  isDefaultCodingIntroText,
} from "@/lib/question-scene-layout";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

const DEFAULT_FILENAME = "coding-intro-default.mp3";

export function defaultCodingIntroTtsUrl(): string {
  return `/api/app-assets/${DEFAULT_FILENAME}`;
}

async function synthesizeMp3(rawText: string): Promise<Buffer> {
  return generateTtsMp3Buffer(rawText);
}

async function writeDefaultFile(buf: Buffer): Promise<string> {
  await putAsset({
    kind: "app",
    relPath: DEFAULT_FILENAME,
    body: buf,
    contentType: "audio/mpeg",
  });
  return defaultCodingIntroTtsUrl();
}

/** Generate once and cache under .data/app-assets/. */
export async function ensureDefaultCodingIntroTts() {
  const url = defaultCodingIntroTtsUrl();
  if ((await assetExists("app", DEFAULT_FILENAME))) {
    return { audioUrl: url, text: CODING_INTRO_SCREEN_TEXT_DEFAULT, cached: true };
  }
  const buf = await synthesizeMp3(CODING_INTRO_SCREEN_TEXT_DEFAULT);
  await writeDefaultFile(buf);
  return { audioUrl: url, text: CODING_INTRO_SCREEN_TEXT_DEFAULT, cached: false };
}

export async function generateCodingIntroTts(text: string) {
  const trimmed = text.trim();
  if (isDefaultCodingIntroText(trimmed) && (await assetExists("app", DEFAULT_FILENAME))) {
    return {
      audioUrl: defaultCodingIntroTtsUrl(),
      text: CODING_INTRO_SCREEN_TEXT_DEFAULT,
      cached: true,
    };
  }
  if (isDefaultCodingIntroText(trimmed)) {
    const buf = await synthesizeMp3(CODING_INTRO_SCREEN_TEXT_DEFAULT);
    const url = await writeDefaultFile(buf);
    return { audioUrl: url, text: CODING_INTRO_SCREEN_TEXT_DEFAULT, cached: false };
  }
  const buf = await synthesizeMp3(trimmed);
  return {
    audioUrl: `data:audio/mpeg;base64,${buf.toString("base64")}`,
    text: trimmed,
    cached: false,
  };
}
