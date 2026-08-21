import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FIXED_TEMPLATE_PRESETS,
  type FixedTemplatePresetId,
  getFixedTemplatePreset,
  isFixedTemplatePresetId,
} from "@/lib/template-fixed-presets";
import { normalizeNarrationText } from "@/lib/narration-text";

function appAssetsRoot(): string {
  return path.join(process.cwd(), ".data", "app-assets");
}

function presetFilePath(id: FixedTemplatePresetId): string {
  return path.join(appAssetsRoot(), getFixedTemplatePreset(id).audioFilename);
}

export function fixedTemplateTtsUrl(id: FixedTemplatePresetId): string {
  return `/api/app-assets/${getFixedTemplatePreset(id).audioFilename}`;
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
    throw new Error(`Template TTS failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function writePresetFile(id: FixedTemplatePresetId, buf: Buffer): string {
  const dir = appAssetsRoot();
  mkdirSync(dir, { recursive: true });
  writeFileSync(presetFilePath(id), buf);
  return fixedTemplateTtsUrl(id);
}

export async function ensureFixedTemplateTts(presetId: string) {
  if (!isFixedTemplatePresetId(presetId)) {
    throw new Error("Unknown fixed template preset");
  }
  const preset = getFixedTemplatePreset(presetId);
  const url = fixedTemplateTtsUrl(presetId);
  if (existsSync(presetFilePath(presetId))) {
    return { audioUrl: url, text: preset.script, cached: true, presetId };
  }
  const buf = await synthesizeMp3(preset.script);
  writePresetFile(presetId, buf);
  return { audioUrl: url, text: preset.script, cached: false, presetId };
}

/** Pre-generate both fixed template voices (optional warm-up). */
export async function ensureAllFixedTemplateTts() {
  const ids = Object.keys(FIXED_TEMPLATE_PRESETS) as FixedTemplatePresetId[];
  const results = await Promise.all(ids.map((id) => ensureFixedTemplateTts(id)));
  return results;
}
