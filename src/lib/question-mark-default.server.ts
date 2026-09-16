import { assetExists, putAsset } from "@/lib/object-storage";
import {
  QUESTION_MARK_SCREEN_TEXT_DEFAULT,
  isDefaultMarkText,
} from "@/lib/question-scene-layout";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

const DEFAULT_FILENAME = "question-mark-default.mp3";

export function defaultMarkTtsUrl(): string {
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
  return defaultMarkTtsUrl();
}

export async function ensureDefaultMarkTts() {
  const url = defaultMarkTtsUrl();
  if ((await assetExists("app", DEFAULT_FILENAME))) {
    return { audioUrl: url, text: QUESTION_MARK_SCREEN_TEXT_DEFAULT, cached: true };
  }
  const buf = await synthesizeMp3(QUESTION_MARK_SCREEN_TEXT_DEFAULT);
  await writeDefaultFile(buf);
  return { audioUrl: url, text: QUESTION_MARK_SCREEN_TEXT_DEFAULT, cached: false };
}

export async function generateMarkTts(text: string) {
  const trimmed = text.trim();
  if (isDefaultMarkText(trimmed) && (await assetExists("app", DEFAULT_FILENAME))) {
    return { audioUrl: defaultMarkTtsUrl(), text: QUESTION_MARK_SCREEN_TEXT_DEFAULT, cached: true };
  }
  if (isDefaultMarkText(trimmed)) {
    const buf = await synthesizeMp3(QUESTION_MARK_SCREEN_TEXT_DEFAULT);
    const url = await writeDefaultFile(buf);
    return { audioUrl: url, text: QUESTION_MARK_SCREEN_TEXT_DEFAULT, cached: false };
  }
  const buf = await synthesizeMp3(trimmed);
  return {
    audioUrl: `data:audio/mpeg;base64,${buf.toString("base64")}`,
    text: trimmed,
    cached: false,
  };
}
