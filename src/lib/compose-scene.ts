import type { Scene } from "@/components/VideoPlayer";
import type { CodeVariant } from "@/components/CodeScene";
import type { NormBbox } from "@/lib/bbox-utils";
import { COMPOSITE_ASPECT } from "@/lib/course-visual-style";
import { parseCorrectLetters, QUESTION_MARK_GAP_MS, QUESTION_MARK_COUNTDOWN_SEC_DEFAULT, QUESTION_MARK_SCREEN_TEXT_DEFAULT, QUESTION_POST_COUNTDOWN_GAP_MS, QUESTION_INTRO_GAP_MS, QUESTION_INTRO_SCREEN_TEXT_DEFAULT } from "@/lib/question-scene-layout";

export type ComposeSourceMode = "upload" | "text" | "code" | "question";

export type QuestionKind = "mcq" | "msq";

export interface ComposeCrop {
  id: string;
  name: string;
  imageUrl: string;
  bbox: NormBbox;
}

export interface ComposePlacement {
  id: string;
  cropId: string;
  startMs: number;
  /** Optional sound played when this crop appears. Omit for silent reveal. */
  sfxUrl?: string | null;
}

/** Placement reveal sound assets. */
export const PLACEMENT_SFX = {
  tick: "/sfx/green-tick.mp3",
  pop: "/sfx/pop.mp3",
} as const;

export type PlacementSfxKey = "none" | keyof typeof PLACEMENT_SFX;

export const PLACEMENT_SFX_OPTIONS: { id: PlacementSfxKey; label: string; url: string | null }[] = [
  { id: "none", label: "No sound", url: null },
  { id: "tick", label: "Tick sound", url: PLACEMENT_SFX.tick },
  { id: "pop", label: "Pop sound", url: PLACEMENT_SFX.pop },
];

/** Default placement reveal sound (green tick). */
export const DEFAULT_PLACEMENT_SFX = PLACEMENT_SFX.tick;

export function placementSfxKey(url: string | null | undefined): PlacementSfxKey {
  if (!url) return "none";
  if (url.includes("pop")) return "pop";
  if (url.includes("green-tick") || url.includes("tick")) return "tick";
  return "tick";
}

export function placementSfxUrl(key: PlacementSfxKey): string | null {
  if (key === "none") return null;
  return PLACEMENT_SFX[key];
}

import type { QuestionKind } from "@/lib/compose-scene";

export interface ComposeDraft {
  script: string;
  title?: string;
  compositeUrl: string | null;
  audioUrl: string | null;
  durationMs: number;
  bgAspect: number;
  crops: ComposeCrop[];
  placements: ComposePlacement[];
  /** Set when using Questions mode (MCQ / MSQ). */
  questionKind?: QuestionKind | null;
}

export function emptyComposeDraft(): ComposeDraft {
  return {
    script: "",
    compositeUrl: null,
    audioUrl: null,
    durationMs: 0,
    bgAspect: COMPOSITE_ASPECT,
    crops: [],
    placements: [],
    questionKind: null,
  };
}

/** Object-contain draw rect inside a container. */
export function imageFitRect(
  containerW: number,
  containerH: number,
  aspect: number,
): { x: number; y: number; w: number; h: number } {
  if (!containerW || !containerH) return { x: 0, y: 0, w: 0, h: 0 };
  const cr = containerW / containerH;
  if (aspect > cr) {
    const w = containerW;
    return { x: 0, y: (containerH - containerW / aspect) / 2, w, h: w / aspect };
  }
  const h = containerH;
  return { x: (containerW - containerH * aspect) / 2, y: 0, w: h * aspect, h };
}

/** Screen-space drag rect → normalized bbox on the source image. */
export function screenRectToNormBbox(
  left: number,
  top: number,
  width: number,
  height: number,
  fit: { x: number; y: number; w: number; h: number },
): NormBbox | null {
  if (width < 4 || height < 4 || fit.w <= 0 || fit.h <= 0) return null;
  const x0 = (left - fit.x) / fit.w;
  const y0 = (top - fit.y) / fit.h;
  const x1 = (left + width - fit.x) / fit.w;
  const y1 = (top + height - fit.y) / fit.h;
  const x = Math.max(0, Math.min(1, Math.min(x0, x1)));
  const y = Math.max(0, Math.min(1, Math.min(y0, y1)));
  const w = Math.max(0.01, Math.min(1 - x, Math.max(x0, x1) - x));
  const h = Math.max(0.01, Math.min(1 - y, Math.max(y0, y1) - y));
  return { x, y, w, h };
}

export function cropImageToDataUrl(
  img: HTMLImageElement,
  bbox: NormBbox,
): string {
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  const sx = Math.round(bbox.x * iw);
  const sy = Math.round(bbox.y * ih);
  const sw = Math.max(1, Math.round(bbox.w * iw));
  const sh = Math.max(1, Math.round(bbox.h * ih));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/png");
}

/** Compose / manual-crop scenes: reveal cropped elements only, not the full composite. */
export function isCropOnlyScene(scene: Pick<Scene, "elements" | "revealCovers">): boolean {
  const els = scene.elements ?? [];
  return els.length > 0 && els.every((e) => !!e.bbox) && !(scene.revealCovers?.length);
}

export function composeDraftToScene(draft: ComposeDraft, sceneId?: string): Scene | null {
  if (!draft.audioUrl || draft.durationMs <= 0) return null;
  const durationMs = draft.durationMs;
  const elements = draft.placements
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
    .map((p) => {
      const crop = draft.crops.find((c) => c.id === p.cropId);
      if (!crop) return null;
      return {
        id: p.id,
        mediaUrl: crop.imageUrl,
        x: crop.bbox.x + crop.bbox.w / 2,
        y: crop.bbox.y + crop.bbox.h / 2,
        w: crop.bbox.w,
        h: crop.bbox.h,
        bbox: crop.bbox,
        appearAt: Math.min(0.98, Math.max(0, p.startMs / durationMs)),
        anim: "fade" as const,
        ...(p.sfxUrl ? { sfxUrl: p.sfxUrl } : {}),
      };
    })
    .filter(Boolean) as NonNullable<Scene["elements"]>;

  return {
    id: sceneId ?? `scene-${Date.now()}`,
    subtitle: draft.title ?? draft.script.slice(0, 48),
    kind: "image",
    audioUrl: draft.audioUrl,
    durationMs,
    animation: "fade",
    narrationText: draft.script,
    bgAspect: draft.bgAspect,
    compositeThumbUrl: draft.compositeUrl ?? undefined,
    elements,
  };
}

export interface ComposeCodeDraft {
  script: string;
  code: string;
  codeLanguage: string;
  codeVariant: CodeVariant;
  title: string;
  audioUrl: string | null;
  durationMs: number;
  ready: boolean;
}

export interface ComposeQuestionDraft {
  kind: QuestionKind;
  question: string;
  subtitle: string;
  options: [string, string, string, string];
  correctInput: string;
  script: string;
  title: string;
  audioUrl: string | null;
  durationMs: number;
  ready: boolean;
  markText: string;
  markGapSec: number;
  markCountdownSec: number;
  markAudioUrl: string | null;
  /** Text used when markAudioUrl was last generated. */
  markAudioForText: string;
  introText: string;
  introGapSec: number;
  introAudioUrl: string | null;
  introDurationMs: number;
  /** Text used when introAudioUrl was last generated. */
  introAudioForText: string;
}

export function emptyComposeQuestionDraft(kind: QuestionKind = "mcq"): ComposeQuestionDraft {
  return {
    kind,
    question: "",
    subtitle: "Question",
    options: ["", "", "", ""],
    correctInput: "",
    script: "",
    title: "",
    audioUrl: null,
    durationMs: 0,
    ready: false,
    markText: QUESTION_MARK_SCREEN_TEXT_DEFAULT,
    markGapSec: QUESTION_MARK_GAP_MS / 1000,
    markCountdownSec: QUESTION_MARK_COUNTDOWN_SEC_DEFAULT,
    markAudioUrl: null,
    markAudioForText: "",
    introText: QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
    introGapSec: QUESTION_INTRO_GAP_MS / 1000,
    introAudioUrl: null,
    introDurationMs: 0,
    introAudioForText: "",
  };
}

export function composeQuestionDraftToScene(
  draft: ComposeQuestionDraft,
  sceneId?: string,
): Scene | null {
  if (!draft.ready || !draft.audioUrl || draft.durationMs <= 0 || !draft.question.trim()) {
    return null;
  }
  const correct = parseCorrectLetters(draft.correctInput, draft.kind);
  const subtitle =
    draft.title.trim() ||
    draft.question.trim().slice(0, 48) ||
    "Question scene";
  return {
    id: sceneId ?? `scene-${Date.now()}`,
    subtitle,
    kind: "question",
    questionKind: draft.kind,
    questionText: draft.question.trim(),
    questionSubtitle: draft.subtitle.trim() || "Question",
    questionOptions: [...draft.options],
    questionCorrect: correct,
    audioUrl: draft.audioUrl,
    durationMs: draft.durationMs,
    questionMarkText: draft.markText.trim() || QUESTION_MARK_SCREEN_TEXT_DEFAULT,
    questionMarkGapMs: Math.round(draft.markGapSec * 1000),
    questionMarkCountdownSec: draft.markCountdownSec,
    questionMarkAudioUrl: draft.markAudioUrl ?? undefined,
    questionIntroText: draft.introText.trim() || QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
    questionIntroGapMs: Math.round(draft.introGapSec * 1000),
    questionIntroAudioUrl: draft.introAudioUrl ?? undefined,
    questionIntroDurationMs: draft.introDurationMs > 0 ? draft.introDurationMs : undefined,
    holdMs: Math.round(
      draft.markGapSec * 1000 +
        draft.markCountdownSec * 1000 +
        QUESTION_POST_COUNTDOWN_GAP_MS,
    ),
    animation: "fade",
    narrationText: draft.script,
  };
}

export function emptyComposeCodeDraft(): ComposeCodeDraft {
  return {
    script: "",
    code: "",
    codeLanguage: "py",
    codeVariant: "typing",
    title: "",
    audioUrl: null,
    durationMs: 0,
    ready: false,
  };
}

export function composeCodeDraftToScene(draft: ComposeCodeDraft, sceneId?: string): Scene | null {
  if (!draft.ready || !draft.audioUrl || draft.durationMs <= 0 || !draft.code.trim()) {
    return null;
  }
  const subtitle =
    draft.title.trim() ||
    draft.script.trim().slice(0, 48) ||
    draft.code.trim().split("\n")[0]?.slice(0, 48) ||
    "Code scene";
  return {
    id: sceneId ?? `scene-${Date.now()}`,
    subtitle,
    kind: "code",
    code: draft.code,
    codeLanguage: draft.codeLanguage,
    codeVariant: draft.codeVariant,
    audioUrl: draft.audioUrl,
    durationMs: draft.durationMs,
    animation: "fade",
    narrationText: draft.script,
  };
}

/** Remove stitched master-track windows so a scene can be edited and re-stitched. */
export function stripSceneStitchMetadata(scene: Scene): Scene {
  const {
    masterAudioUrl: _m,
    startMs: _s,
    endMs: _e,
    holdMs: _h,
    transitionMs: _t,
    ...rest
  } = scene;
  return rest;
}

export function sceneSourceMode(scene: Scene): ComposeSourceMode {
  if (scene.kind === "code") return "code";
  if (scene.kind === "question") return "question";
  return "upload";
}

export function sceneToComposeDraft(scene: Scene): ComposeDraft | null {
  if (scene.kind !== "image") return null;
  const durationMs = scene.durationMs || 1;
  const crops: ComposeCrop[] = [];
  const placements: ComposePlacement[] = [];
  for (const el of scene.elements ?? []) {
    if (!el.bbox) continue;
    crops.push({
      id: el.id,
      name: el.label ?? el.id,
      imageUrl: el.mediaUrl,
      bbox: el.bbox,
    });
    placements.push({
      id: el.id,
      cropId: el.id,
      startMs: Math.round(el.appearAt * durationMs),
      sfxUrl: el.sfxUrl ?? null,
    });
  }
  return {
    script: scene.narrationText ?? "",
    title: scene.subtitle,
    compositeUrl: scene.compositeThumbUrl ?? scene.backgroundUrl ?? null,
    audioUrl: scene.audioUrl,
    durationMs,
    bgAspect: scene.bgAspect ?? COMPOSITE_ASPECT,
    crops,
    placements,
  };
}

export function sceneToCodeDraft(scene: Scene): ComposeCodeDraft | null {
  if (scene.kind !== "code") return null;
  return {
    script: scene.narrationText ?? "",
    code: scene.code ?? "",
    codeLanguage: scene.codeLanguage ?? "py",
    codeVariant: scene.codeVariant ?? "typing",
    title: scene.subtitle,
    audioUrl: scene.audioUrl,
    durationMs: scene.durationMs,
    ready: !!scene.audioUrl && scene.durationMs > 0,
  };
}

export function sceneToQuestionDraft(scene: Scene): ComposeQuestionDraft | null {
  if (scene.kind !== "question") return null;
  const opts = scene.questionOptions ?? ["", "", "", ""];
  const markText = scene.questionMarkText?.trim() || QUESTION_MARK_SCREEN_TEXT_DEFAULT;
  const introText = scene.questionIntroText?.trim() || QUESTION_INTRO_SCREEN_TEXT_DEFAULT;
  return {
    kind: scene.questionKind ?? "mcq",
    question: scene.questionText ?? "",
    subtitle: scene.questionSubtitle ?? "Question",
    options: [opts[0] ?? "", opts[1] ?? "", opts[2] ?? "", opts[3] ?? ""],
    correctInput: (scene.questionCorrect ?? []).join(", "),
    script: scene.narrationText ?? "",
    title: scene.subtitle,
    audioUrl: scene.audioUrl,
    durationMs: scene.durationMs,
    ready: !!scene.audioUrl && scene.durationMs > 0,
    markText,
    markGapSec: (scene.questionMarkGapMs ?? QUESTION_MARK_GAP_MS) / 1000,
    markCountdownSec: scene.questionMarkCountdownSec ?? QUESTION_MARK_COUNTDOWN_SEC_DEFAULT,
    markAudioUrl: scene.questionMarkAudioUrl ?? null,
    markAudioForText: markText,
    introText,
    introGapSec: (scene.questionIntroGapMs ?? QUESTION_INTRO_GAP_MS) / 1000,
    introAudioUrl: scene.questionIntroAudioUrl ?? null,
    introDurationMs: scene.questionIntroDurationMs ?? 0,
    introAudioForText: introText,
  };
}
