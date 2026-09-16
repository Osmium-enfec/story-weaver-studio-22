import { assetExists, putAsset } from "@/lib/object-storage";
import {
  FIXED_TEMPLATE_PRESETS,
  type FixedTemplatePresetId,
  getFixedTemplatePreset,
  isFixedTemplatePresetId,
} from "@/lib/template-fixed-presets";
import { generateTtsMp3Buffer } from "@/lib/tts.server";

export function fixedTemplateTtsUrl(id: FixedTemplatePresetId): string {
  return `/api/app-assets/${getFixedTemplatePreset(id).audioFilename}`;
}

async function synthesizeMp3(rawText: string): Promise<Buffer> {
  return generateTtsMp3Buffer(rawText);
}

async function writePresetFile(id: FixedTemplatePresetId, buf: Buffer): Promise<string> {
  await putAsset({
    kind: "app",
    relPath: getFixedTemplatePreset(id).audioFilename,
    body: buf,
    contentType: "audio/mpeg",
  });
  return fixedTemplateTtsUrl(id);
}

export async function ensureFixedTemplateTts(presetId: string) {
  if (!isFixedTemplatePresetId(presetId)) {
    throw new Error("Unknown fixed template preset");
  }
  const preset = getFixedTemplatePreset(presetId);
  const url = fixedTemplateTtsUrl(presetId);
  if ((await assetExists("app", preset.audioFilename))) {
    return { audioUrl: url, text: preset.script, cached: true, presetId };
  }
  const buf = await synthesizeMp3(preset.script);
  await writePresetFile(presetId, buf);
  return { audioUrl: url, text: preset.script, cached: false, presetId };
}

/** Pre-generate both fixed template voices (optional warm-up). */
export async function ensureAllFixedTemplateTts() {
  const ids = Object.keys(FIXED_TEMPLATE_PRESETS) as FixedTemplatePresetId[];
  const results = await Promise.all(ids.map((id) => ensureFixedTemplateTts(id)));
  return results;
}
