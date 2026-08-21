/** Built-in template cards — fixed copy, voice, and styling (not editable in Compose). */

export type FixedTemplatePresetId = "try-question" | "try-coding";

export const FIXED_TEMPLATE_FONT_SIZE = 100;
export const FIXED_TEMPLATE_TEXT_COLOR = "#1a1a1a";

export interface FixedTemplatePreset {
  id: FixedTemplatePresetId;
  label: string;
  desc: string;
  text: string;
  script: string;
  title: string;
  audioFilename: string;
}

export const FIXED_TEMPLATE_PRESETS: Record<FixedTemplatePresetId, FixedTemplatePreset> = {
  "try-question": {
    id: "try-question",
    label: "Try a question",
    desc: "Now try to solve this question",
    text: "Now try to solve this question",
    script: "Now try to solve this question",
    title: "Try a question",
    audioFilename: "template-try-question-default.mp3",
  },
  "try-coding": {
    id: "try-coding",
    label: "Try coding",
    desc: "Now try to solve one coding problem",
    text: "Now try to solve one coding problem",
    script: "Now try to solve one coding problem",
    title: "Try coding",
    audioFilename: "template-try-coding-default.mp3",
  },
};

export const FIXED_TEMPLATE_PRESET_LIST = Object.values(FIXED_TEMPLATE_PRESETS);

export function isFixedTemplatePresetId(id: string): id is FixedTemplatePresetId {
  return id === "try-question" || id === "try-coding";
}

export function getFixedTemplatePreset(id: FixedTemplatePresetId): FixedTemplatePreset {
  return FIXED_TEMPLATE_PRESETS[id];
}
