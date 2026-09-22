export type TemplateTheme = "orange" | "blue";

export interface TemplateThemePalette {
  accent: string;
  stops: readonly [string, string, string];
  cssGradient: string;
  soft: string;
  softStrong: string;
}

export const TEMPLATE_THEME_OPTIONS: Array<{
  id: TemplateTheme;
  label: string;
  description: string;
}> = [
  {
    id: "blue",
    label: "Blue gradient",
    description: "Matches the Zero Code background",
  },
  {
    id: "orange",
    label: "Orange gradient",
    description: "Original Div Studio template style",
  },
];

const PALETTES: Record<TemplateTheme, TemplateThemePalette> = {
  orange: {
    accent: "#f67e00",
    stops: ["#ffb404", "#f67e00", "#e13900"],
    cssGradient: "linear-gradient(90deg, #ffb404 0%, #f67e00 50%, #e13900 100%)",
    soft: "#fff7ed",
    softStrong: "#ffedd5",
  },
  blue: {
    accent: "#0ea5e9",
    stops: ["#22d3ee", "#0ea5e9", "#2563eb"],
    cssGradient: "linear-gradient(90deg, #22d3ee 0%, #0ea5e9 50%, #2563eb 100%)",
    soft: "#f0f9ff",
    softStrong: "#e0f2fe",
  },
};

export function templateThemeForCourseName(name?: string | null): TemplateTheme {
  return /zero\s*-?\s*code/i.test(name ?? "") ? "blue" : "orange";
}

export function templatePalette(theme?: TemplateTheme | null): TemplateThemePalette {
  return PALETTES[theme === "blue" ? "blue" : "orange"];
}

export function canvasTemplateGradient(
  ctx: CanvasRenderingContext2D,
  theme: TemplateTheme | null | undefined,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): CanvasGradient {
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  const stops = templatePalette(theme).stops;
  gradient.addColorStop(0, stops[0]);
  gradient.addColorStop(0.5, stops[1]);
  gradient.addColorStop(1, stops[2]);
  return gradient;
}