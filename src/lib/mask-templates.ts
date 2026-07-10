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
// Natural top-down MCQ layout — matches how GPT lays elements out in the
// generated image (title at top, subtitle under it, 4 option cards in a row,
// answer banner at bottom). Keep fractions in sync with the prompt in
// `src/lib/mcq-image.functions.ts`.
const mcq: MaskTemplate = {
  id: "mcq-four-card",
  label: "MCQ · four cards",
  aspect: 1536 / 1024,
  regions: [
    { id: "title",    label: "Title banner",  x: 0.08, y: 0.06, w: 0.84, h: 0.14, defaultAnim: "fade", defaultDurationMs: 1000 },
    { id: "subtitle", label: "Subtitle",      x: 0.15, y: 0.22, w: 0.70, h: 0.06, defaultAnim: "fade", defaultDurationMs: 1000 },
    { id: "option-a", label: "Option A",      x: 0.05, y: 0.32, w: 0.21, h: 0.50, defaultAnim: "fade", defaultDurationMs: 1000 },
    { id: "option-b", label: "Option B",      x: 0.28, y: 0.32, w: 0.21, h: 0.50, defaultAnim: "fade", defaultDurationMs: 1000 },
    { id: "option-c", label: "Option C",      x: 0.51, y: 0.32, w: 0.21, h: 0.50, defaultAnim: "fade", defaultDurationMs: 1000 },
    { id: "option-d", label: "Option D",      x: 0.74, y: 0.32, w: 0.21, h: 0.50, defaultAnim: "fade", defaultDurationMs: 1000 },
    { id: "answer",   label: "Answer banner", x: 0.10, y: 0.85, w: 0.80, h: 0.11, defaultAnim: "fade", defaultDurationMs: 1000 },
  ].map((r) => ({ ...r, padX: 0.015, padY: 0.025 } as TemplateRegion)),
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
