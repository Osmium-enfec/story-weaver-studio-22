// Reusable layout templates for the mask-reveal system.
// Coordinates are fractions of the canvas (0-1) so the same template
// works for any uploaded image size.

export type RevealAnimation =
  | "fade"
  | "wipe-left"
  | "wipe-right"
  | "wipe-up"
  | "wipe-down"
  | "instant";

export type Ease = "linear" | "ease-out" | "ease-in-out";

export interface TemplateRegion {
  id: string;
  label: string;
  /** Fractional bbox (0-1) of the CONTENT area. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Extra padding (fraction of canvas) added around the mask for safety. */
  padX?: number;
  padY?: number;
  /** Default animation & timing seed (ms). */
  defaultAnim?: RevealAnimation;
  defaultDurationMs?: number;
}

export interface MaskTemplate {
  id: string;
  label: string;
  /** Canvas aspect ratio hint for preview when no image is loaded. */
  aspect: number; // w/h
  regions: TemplateRegion[];
}

// Derived from the 1659x948 MCQ coordinates already dialed in.
const mcq: MaskTemplate = {
  id: "mcq-four-card",
  label: "MCQ · four cards",
  aspect: 1659 / 948,
  regions: [
    { id: "title", label: "Title banner", x: 339 / 1659, y: 559 / 948, w: 741 / 1659, h: 151 / 948, defaultAnim: "fade", defaultDurationMs: 400 },
    { id: "subtitle", label: "Subtitle", x: 419 / 1659, y: 218 / 948, w: 189 / 1659, h: 43 / 948, defaultAnim: "wipe-left", defaultDurationMs: 400 },
    { id: "option-a", label: "Option A", x: 113 / 1659, y: 315 / 948, w: 274 / 1659, h: 584 / 948, defaultAnim: "wipe-left", defaultDurationMs: 450 },
    { id: "option-b", label: "Option B", x: 478 / 1659, y: 315 / 948, w: 331 / 1659, h: 458 / 948, defaultAnim: "wipe-left", defaultDurationMs: 450 },
    { id: "option-c", label: "Option C", x: 846 / 1659, y: 315 / 948, w: 331 / 1659, h: 458 / 948, defaultAnim: "wipe-left", defaultDurationMs: 450 },
    { id: "option-d", label: "Option D", x: 1215 / 1659, y: 315 / 948, w: 321 / 1659, h: 458 / 948, defaultAnim: "wipe-left", defaultDurationMs: 450 },
    { id: "answer", label: "Answer banner", x: 322 / 1659, y: 790 / 948, w: 1025 / 1659, h: 114 / 948, defaultAnim: "fade", defaultDurationMs: 600 },
  ].map((r) => ({ ...r, padX: 0.012, padY: 0.02 } as TemplateRegion)),
};

const comparison: MaskTemplate = {
  id: "comparison-two-column",
  label: "Comparison · two columns",
  aspect: 16 / 9,
  regions: [
    { id: "title", label: "Title", x: 0.15, y: 0.04, w: 0.7, h: 0.12, defaultAnim: "fade", defaultDurationMs: 400 },
    { id: "left", label: "Left column", x: 0.05, y: 0.22, w: 0.42, h: 0.7, defaultAnim: "wipe-right", defaultDurationMs: 500 },
    { id: "right", label: "Right column", x: 0.53, y: 0.22, w: 0.42, h: 0.7, defaultAnim: "wipe-left", defaultDurationMs: 500 },
  ].map((r) => ({ ...r, padX: 0.015, padY: 0.02 } as TemplateRegion)),
};

const threeStep: MaskTemplate = {
  id: "three-step-process",
  label: "Three-step process",
  aspect: 16 / 9,
  regions: [
    { id: "title", label: "Title", x: 0.15, y: 0.05, w: 0.7, h: 0.12, defaultAnim: "fade", defaultDurationMs: 400 },
    { id: "step-1", label: "Step 1", x: 0.04, y: 0.28, w: 0.28, h: 0.6, defaultAnim: "wipe-left", defaultDurationMs: 450 },
    { id: "step-2", label: "Step 2", x: 0.36, y: 0.28, w: 0.28, h: 0.6, defaultAnim: "wipe-left", defaultDurationMs: 450 },
    { id: "step-3", label: "Step 3", x: 0.68, y: 0.28, w: 0.28, h: 0.6, defaultAnim: "wipe-left", defaultDurationMs: 450 },
  ].map((r) => ({ ...r, padX: 0.012, padY: 0.02 } as TemplateRegion)),
};

const titleThree: MaskTemplate = {
  id: "title-with-three-points",
  label: "Title + three points",
  aspect: 16 / 9,
  regions: [
    { id: "title", label: "Title", x: 0.1, y: 0.06, w: 0.8, h: 0.16, defaultAnim: "fade", defaultDurationMs: 400 },
    { id: "point-1", label: "Point 1", x: 0.1, y: 0.3, w: 0.8, h: 0.16, defaultAnim: "wipe-left", defaultDurationMs: 400 },
    { id: "point-2", label: "Point 2", x: 0.1, y: 0.5, w: 0.8, h: 0.16, defaultAnim: "wipe-left", defaultDurationMs: 400 },
    { id: "point-3", label: "Point 3", x: 0.1, y: 0.7, w: 0.8, h: 0.16, defaultAnim: "wipe-left", defaultDurationMs: 400 },
  ].map((r) => ({ ...r, padX: 0.015, padY: 0.02 } as TemplateRegion)),
};

export const TEMPLATES: MaskTemplate[] = [mcq, comparison, threeStep, titleThree];

export function getTemplate(id: string): MaskTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
