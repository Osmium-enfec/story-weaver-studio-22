// Scene background theming. "whiteboard" keeps the AI-generated hand-drawn
// background; "solid" and "gradient" replace it with a designer-picked color
// canvas and a padded white card that hosts the elements (see reference SS2).

export type SceneBackground =
  | { kind: "whiteboard" }
  | { kind: "solid"; color: string }
  | { kind: "gradient"; from: string; to: string; angle?: number };

export const DEFAULT_BACKGROUND: SceneBackground = { kind: "whiteboard" };

export function backgroundToCss(bg: SceneBackground): string {
  if (bg.kind === "solid") return bg.color;
  if (bg.kind === "gradient") {
    const angle = bg.angle ?? 135;
    return `linear-gradient(${angle}deg, ${bg.from}, ${bg.to})`;
  }
  return "#ffffff";
}

/** Inner white card inset when a custom background is in use. */
export const CARD_PADDING_FRAC = 0.04;
