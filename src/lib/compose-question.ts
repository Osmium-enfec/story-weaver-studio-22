import type { ComposeCrop, ComposePlacement } from "@/lib/compose-scene";
import { cropImageToDataUrl, DEFAULT_PLACEMENT_SFX } from "@/lib/compose-scene";
import type { QuestionKind } from "@/lib/compose-scene";
import type { MaskTemplate } from "@/lib/mask-templates";
import { getTemplate } from "@/lib/mask-templates";

export type { QuestionKind };

export const QUESTION_TEMPLATE_ID: Record<QuestionKind, string> = {
  mcq: "mcq-four-card",
  msq: "msq-four-card",
};

export const QUESTION_KIND_LABELS: Record<QuestionKind, string> = {
  mcq: "MCQ · pick one",
  msq: "MSQ · pick many",
};

export function templateForQuestion(kind: QuestionKind): MaskTemplate {
  return getTemplate(QUESTION_TEMPLATE_ID[kind]);
}

/** Build crops from fixed template regions on a generated question infographic. */
export function cropsFromQuestionTemplate(
  template: MaskTemplate,
  img: HTMLImageElement,
): ComposeCrop[] {
  return template.regions.map((r) => ({
    id: r.id,
    name: r.label,
    bbox: { x: r.x, y: r.y, w: r.w, h: r.h },
    imageUrl: cropImageToDataUrl(img, { x: r.x, y: r.y, w: r.w, h: r.h }),
  }));
}

/** Spread reveals evenly across the narration (title → options → answer). */
export function placementsFromQuestionTemplate(
  template: MaskTemplate,
  durationMs: number,
): ComposePlacement[] {
  const regions = template.regions;
  const n = regions.length;
  const usable = Math.max(1000, durationMs * 0.88);
  return regions.map((r, i) => ({
    id: `pl-${r.id}`,
    cropId: r.id,
    startMs: n <= 1 ? 0 : Math.round((usable * i) / (n - 1)),
    sfxUrl: DEFAULT_PLACEMENT_SFX,
  }));
}
