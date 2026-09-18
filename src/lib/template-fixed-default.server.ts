import {
  FIXED_TEMPLATE_PRESETS,
  type FixedTemplatePresetId,
  isFixedTemplatePresetId,
} from "@/lib/template-fixed-presets";
import { ensureDefaultVoiceAsset } from "@/lib/default-voice-assets.server";
import { legacyDefaultAudioUrl } from "@/lib/default-voice-assets";

export function fixedTemplateTtsUrl(id: FixedTemplatePresetId): string {
  return legacyDefaultAudioUrl(id);
}

export async function ensureFixedTemplateTts(presetId: string, courseId?: string | null) {
  if (!isFixedTemplatePresetId(presetId)) {
    throw new Error("Unknown fixed template preset");
  }
  const r = await ensureDefaultVoiceAsset(presetId, courseId);
  return { audioUrl: r.audioUrl, text: r.text, cached: r.cached, presetId };
}

/** Pre-generate both fixed template voices (optional warm-up). */
export async function ensureAllFixedTemplateTts(courseId?: string | null) {
  const ids = Object.keys(FIXED_TEMPLATE_PRESETS) as FixedTemplatePresetId[];
  return Promise.all(ids.map((id) => ensureFixedTemplateTts(id, courseId)));
}
