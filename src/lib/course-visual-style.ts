/**
 * Python-for-AI course visual system — style guide for image generation.
 */

/** gpt-image-1 landscape size (3:2 — closest supported wide format). */
export const COMPOSITE_IMAGE_SIZE = "1536x1024";
export const COMPOSITE_ASPECT = 1536 / 1024;

export const REFERENCE_LAYOUT = `Create a clean Excalidraw-style educational infographic on a pure white background, landscape ${COMPOSITE_IMAGE_SIZE.replace("x", "×")}.

Compose the content in a centered wide 16:9-style band (title, cards, footer) with extra white padding above and below — do not fill the full canvas height with heavy blocks.

Layout — classroom whiteboard poster with clearly separated hand-drawn regions:
- TOP: wide hand-drawn blue title ribbon, centered, slightly wobbly sketch borders, small sparkle-star doodles on BOTH left and right sides
- Below title: one smaller purple subtitle section with ONE short line and a hand-drawn wavy underline on a key phrase
- MIDDLE: exactly FIVE separate tall rounded concept cards in one horizontal row with generous white gaps between them
- BOTTOM: one wide lavender footer banner with ONE short summary sentence, purple star doodle on the left, yellow lightbulb doodle on the right

Each section must be clearly separated. Keep enough white space so every card can be cropped individually. Make every section animation-friendly and clearly isolated. No overlapping arrows, icons, or text.`;

export const COURSE_VISUAL_STYLE = `Visual style:
Clean Excalidraw-style educational infographic on a white background.
Hand-drawn black outlines, pastel fills, rounded cards, playful doodle icons, large readable handwritten text.
Beginner-friendly, classroom whiteboard feel, minimal text, more visuals.
No overlapping arrows, icons, or text.
Use blue for Python/main titles, green for correct/success, red for wrong/errors, purple for technical concepts, orange/yellow for hints.
Images should be easy to animate element-by-element.`;

export const VISUAL_LANGUAGE = `Visual language — use these color meanings consistently:
- Blue for titles and primary headings
- Green for correct / useful / positive concepts
- Purple for technical emphasis
- Yellow / orange for hints or settings
- Pink / red for contrast where needed`;

export const ICON_GUIDANCE = `Icon style — use simple doodle icons, not literal objects:
- String / text: text bubble, quote mark, or label icon (not a rope)
- Integer: 123 number block or checklist
- Float: thermometer or decimal number bubble
- Boolean: checkmark or yes-no toggle
- Foundation / robot: friendly doodle mascot
- Footer accents: purple star, yellow lightbulb`;

export const TEXT_DENSITY = `Text density — keep copy very short:
- 1 title, 1 short subtitle, 1 short footer sentence
- Card descriptions: 3–5 words max (e.g. "Prompts, responses, model names" not "Used for prompts, responses, and model names")
- Example pills: one short value only`;

export const ANTI_CLEAN_DIGITAL = `Strictly avoid — do NOT look like:
- Flat vector infographic, polished corporate slide, dashboard UI
- Canva / PowerPoint / flat vector template, stock illustration pack
- Glossy 3D artwork, photorealistic image

Must feel like: hand-drawn marker sketch on white paper, Excalidraw-style educational poster, cute imperfect classroom visual.`;

export const COURSE_COLORS = {
  pythonTitle: { fill: "#DBEAFE", ink: "#2563EB" },
  success: { fill: "#DCFCE7", ink: "#16A34A" },
  error: { fill: "#FEE2E2", ink: "#DC2626" },
  technical: { fill: "#EDE9FE", ink: "#7C3AED" },
  hint: { fill: "#FEF3C7", ink: "#D97706" },
} as const;

/** Image prompt: intro + structured labels + visual style (not raw narration). */
export function buildCompositeImagePrompt(scenePrompt: string, _title?: string): string {
  return `Create an Excalidraw style image for this text:

${scenePrompt}

Do not paste long narration sentences on the image — only the short title, subtitle, card labels, and footer below.

${COURSE_VISUAL_STYLE}`;
}

export const COMPOSITE_BOX_RETRY_SUFFIX = "";
