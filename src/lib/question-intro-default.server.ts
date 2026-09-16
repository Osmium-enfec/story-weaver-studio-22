import { assetExists, putAsset } from "@/lib/object-storage";
import {
  QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
  isDefaultIntroText,
} from "@/lib/question-scene-layout";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

const DEFAULT_FILENAME = "question-intro-default.mp3";

export function defaultIntroTtsUrl(): string {
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
  return defaultIntroTtsUrl();
}

export async function ensureDefaultIntroTts() {
  const url = defaultIntroTtsUrl();
  if ((await assetExists("app", DEFAULT_FILENAME))) {
    return { audioUrl: url, text: QUESTION_INTRO_SCREEN_TEXT_DEFAULT, cached: true };
  }
  const buf = await synthesizeMp3(QUESTION_INTRO_SCREEN_TEXT_DEFAULT);
  await writeDefaultFile(buf);
  return { audioUrl: url, text: QUESTION_INTRO_SCREEN_TEXT_DEFAULT, cached: false };
}

export async function generateIntroTts(text: string) {
  const trimmed = text.trim();
  if (isDefaultIntroText(trimmed) && (await assetExists("app", DEFAULT_FILENAME))) {
    return { audioUrl: defaultIntroTtsUrl(), text: QUESTION_INTRO_SCREEN_TEXT_DEFAULT, cached: true };
  }
  if (isDefaultIntroText(trimmed)) {
    const buf = await synthesizeMp3(QUESTION_INTRO_SCREEN_TEXT_DEFAULT);
    const url = await writeDefaultFile(buf);
    return { audioUrl: url, text: QUESTION_INTRO_SCREEN_TEXT_DEFAULT, cached: false };
  }
  const buf = await synthesizeMp3(trimmed);
  return {
    audioUrl: `data:audio/mpeg;base64,${buf.toString("base64")}`,
    text: trimmed,
    cached: false,
  };
}
