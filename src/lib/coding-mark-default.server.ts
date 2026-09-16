import { assetExists, putAsset } from "@/lib/object-storage";
import {
  CODING_MARK_SCREEN_TEXT_DEFAULT,
  isDefaultCodingMarkText,
} from "@/lib/question-scene-layout";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

const DEFAULT_FILENAME = "coding-mark-default.mp3";

export function defaultCodingMarkTtsUrl(): string {
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
