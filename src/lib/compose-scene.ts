import type { Scene } from "@/components/VideoPlayer";
import type { CodeVariant } from "@/components/CodeScene";
import type { NormBbox } from "@/lib/bbox-utils";
import { COMPOSITE_ASPECT } from "@/lib/course-visual-style";
import type { CodeTypingBeat } from "@/lib/code-scene-sfx";
import {
  beatsToFullCode,
  DEFAULT_CODE_OUTPUT_HOLD_MS,
  DEFAULT_CODE_RUN_DELAY_MS,
  DEFAULT_CODE_TYPING_CPS,
  LEGACY_CODE_TYPING_CPS,
  resolveCodeTypingBeats,
} from "@/lib/code-scene-sfx";

/** Defaults for Template → Code typing scenes (user-overridable). */
export const TEMPLATE_CODE_TYPING_CPS = 15;
export const TEMPLATE_CODE_RUN_DELAY_MS = 1000;
export const TEMPLATE_CODE_TITLE = "hello.py";
import {
  DEFAULT_CAMERA_ZOOM_DURATION_MS,
  DEFAULT_CAMERA_ZOOM_SFX,
  normalizeRecordingCameraKeyframes,
  normalizeRecordingCameraZoomSfx,
  clampCameraZoomDurationMs,
  type RecordingCameraKeyframe,
  type RecordingCameraZoomSfx,
} from "@/lib/recording-camera";
import {
  normalizeRecordingBlurRegion,
  type RecordingBlurRegion,
} from "@/lib/recording-blur";
import {
  normalizeRecordingHighlights,
  type RecordingHighlight,
} from "@/lib/recording-highlight";
import {
  parseCorrectLetters,
  QUESTION_MARK_GAP_MS,
  QUESTION_MARK_COUNTDOWN_SEC_DEFAULT,
  QUESTION_MARK_SCREEN_TEXT_DEFAULT,
  QUESTION_POST_COUNTDOWN_GAP_MS,
  QUESTION_INTRO_GAP_MS,
  QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
  CODING_INTRO_SCREEN_TEXT_DEFAULT,
  CODING_MARK_SCREEN_TEXT_DEFAULT,
  emptyCodingTestCases,
  questionPreQuestionMs,
  questionPostSpeechVisualMs,
} from "@/lib/question-scene-layout";
import { revealSpeechDurationMs } from "@/lib/reveal-schedule";
import { templateCountdownDurationMs } from "@/lib/template-scene-canvas";
import { sceneGapMs, sceneTransitionMs } from "@/lib/scene-transition";
import { healCommonBumperScene } from "@/lib/common-intro-outro";
import {
  FIXED_TEMPLATE_FONT_SIZE,
  FIXED_TEMPLATE_TEXT_COLOR,
  getFixedTemplatePreset,
  type FixedTemplatePresetId,
} from "@/lib/template-fixed-presets";

export type ComposeSourceMode =
  | "script"
  | "upload"
  | "text"
  | "code"
  | "question"
  | "template"
  | "recording"
  /**
   * Screen recording with mic → auto STT, strip fillers, local Kokoro TTS,
   * same-length silent video + replacement audio. No manual transcript step.
   */
  | "recording2"
  /** Video that already has audio — no TTS / sync timeline. */
  | "clip";

/** True for Screen recording / Screen recording 2 / Video clip compose modes. */
export function isRecordingLikeMode(mode: ComposeSourceMode): boolean {
  return mode === "recording" || mode === "recording2" || mode === "clip";
}

export type QuestionKind = "mcq" | "msq" | "coding" | "predictOutput";
/** MCQ vs MSQ option style inside predict-output questions. */
export type PredictSelectMode = "mcq" | "msq";

export interface CodingTestCaseDraft {
  label: string;
  input: string;
  output: string;
}

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

/** Default: no reveal sound on new placements. */
export const DEFAULT_PLACEMENT_SFX: string | null = null;

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
  /** No voiceover — silent track + BGM only (templates → code typing). */
  silentNarration?: boolean;
  /** Typing speed in characters per second (silent / timed typing). */
  typingSpeedCps?: number;
  /** Distinguishes current user-entered values from legacy 28 cps defaults. */
  defaultsVersion?: 2;
  /** Code editor font size in px (typing preview + export). */
  codeFontSize?: number;
  /** Console output revealed after Run (user-authored). Legacy single-step mirror. */
  codeOutput?: string;
  /** Delay after typing ends before Run presses (ms). Legacy mirror. */
  codeRunDelayMs?: number;
  /** How long to show output after Run (ms). Legacy mirror. */
  codeOutputHoldMs?: number;
  /** Multi-step type → run → output cycles (preferred for code typing templates). */
  codeTypingBeats?: CodeTypingBeat[];
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
  /** Probed duration of markAudioUrl (ms). */
  markDurationMs: number;
  introText: string;
  introGapSec: number;
  introAudioUrl: string | null;
  introDurationMs: number;
  /** Text used when introAudioUrl was last generated. */
  introAudioForText: string;
  /** Coding-problem fields (used when kind === "coding"). */
  codingTitle: string;
  codingStarterCode: string;
  codingPaste: string;
  codingTestCases: [CodingTestCaseDraft, CodingTestCaseDraft, CodingTestCaseDraft];
  /** Predict-output: code shown between question and options. */
  predictCode: string;
  /** Predict-output: pick-one vs pick-many options. */
  predictSelectMode: PredictSelectMode;
}

export function emptyComposeQuestionDraft(kind: QuestionKind = "mcq"): ComposeQuestionDraft {
  const isCoding = kind === "coding";
  const isPredict = kind === "predictOutput";
  return {
    kind,
    question: "",
    subtitle: isCoding ? "Coding Problem" : isPredict ? "Predict output" : "Question",
    options: ["", "", "", ""],
    correctInput: "",
    script: "",
    title: "",
    audioUrl: null,
    durationMs: 0,
    ready: false,
    markText: isCoding ? CODING_MARK_SCREEN_TEXT_DEFAULT : QUESTION_MARK_SCREEN_TEXT_DEFAULT,
    markGapSec: QUESTION_MARK_GAP_MS / 1000,
    markCountdownSec: QUESTION_MARK_COUNTDOWN_SEC_DEFAULT,
    markAudioUrl: null,
    markAudioForText: "",
    markDurationMs: 0,
    introText: isCoding ? CODING_INTRO_SCREEN_TEXT_DEFAULT : QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
    introGapSec: QUESTION_INTRO_GAP_MS / 1000,
    introAudioUrl: null,
    introDurationMs: 0,
    introAudioForText: "",
    codingTitle: "",
    codingStarterCode: "",
    codingPaste: "",
    codingTestCases: emptyCodingTestCases(),
    predictCode: "",
    predictSelectMode: "mcq",
  };
}

export function composeQuestionDraftToScene(
  draft: ComposeQuestionDraft,
  sceneId?: string,
): Scene | null {
  const isCoding = draft.kind === "coding";
  const isPredict = draft.kind === "predictOutput";
  const hasCore = isCoding
    ? draft.codingTitle.trim().length > 0 &&
      draft.question.trim().length > 0 &&
      draft.codingStarterCode.trim().length > 0 &&
      draft.codingTestCases.filter((t) => t.input.trim() && t.output.trim()).length >= 1
    : isPredict
      ? draft.question.trim().length > 0 && draft.predictCode.trim().length > 0
      : draft.question.trim().length > 0;
  if (!draft.ready || !draft.audioUrl || draft.durationMs <= 0 || !hasCore) {
    return null;
  }
  const correct = parseCorrectLetters(
    draft.correctInput,
    draft.kind,
    draft.predictSelectMode,
  );
  const subtitle =
    draft.title.trim() ||
    (isCoding
      ? draft.codingTitle.trim() || draft.question.trim().slice(0, 48) || "Coding problem"
      : draft.question.trim().slice(0, 48) || "Question scene");
  return {
    id: sceneId ?? `scene-${Date.now()}`,
    subtitle,
    kind: "question",
    questionKind: draft.kind,
    questionText: draft.question.trim(),
    questionSubtitle: isCoding
      ? draft.codingTitle.trim() || draft.subtitle.trim() || "Coding Problem"
      : isPredict
        ? draft.subtitle.trim() || "Predict output"
        : draft.subtitle.trim() || "Question",
    questionOptions: isCoding ? ["", "", "", ""] : [...draft.options],
    questionCorrect: correct,
    questionCode: isPredict ? draft.predictCode : undefined,
    predictSelectMode: isPredict ? draft.predictSelectMode : undefined,
    codingTitle: isCoding ? draft.codingTitle.trim() : undefined,
    codingStarterCode: isCoding ? draft.codingStarterCode : undefined,
    codingTestCases: isCoding
      ? draft.codingTestCases
          .filter((t) => t.input.trim() || t.output.trim())
          .slice(0, 3)
          .map((t, i) => ({
            label: t.label.trim() || `Case ${i + 1}`,
            input: t.input.trim(),
            output: t.output.trim(),
          }))
      : undefined,
    audioUrl: draft.audioUrl,
    durationMs: draft.durationMs,
    questionMarkText:
      draft.markText.trim() ||
      (isCoding ? CODING_MARK_SCREEN_TEXT_DEFAULT : QUESTION_MARK_SCREEN_TEXT_DEFAULT),
    questionMarkGapMs: Math.round(draft.markGapSec * 1000),
    questionMarkCountdownSec: draft.markCountdownSec,
    questionMarkAudioUrl: draft.markAudioUrl ?? undefined,
    questionMarkDurationMs: draft.markDurationMs > 0 ? draft.markDurationMs : undefined,
    questionIntroText:
      draft.introText.trim() ||
      (isCoding ? CODING_INTRO_SCREEN_TEXT_DEFAULT : QUESTION_INTRO_SCREEN_TEXT_DEFAULT),
    questionIntroGapMs: Math.round(draft.introGapSec * 1000),
    questionIntroAudioUrl: draft.introAudioUrl ?? undefined,
    questionIntroDurationMs: draft.introDurationMs > 0 ? draft.introDurationMs : undefined,
    holdMs: Math.round(
      draft.markGapSec * 1000 +
        Math.max(
          draft.markCountdownSec * 1000 + QUESTION_POST_COUNTDOWN_GAP_MS,
          (draft.markDurationMs > 0 ? draft.markDurationMs + 250 : 0) ||
            draft.markCountdownSec * 1000 + QUESTION_POST_COUNTDOWN_GAP_MS,
        ),
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
    silentNarration: false,
    typingSpeedCps: DEFAULT_CODE_TYPING_CPS,
    defaultsVersion: 2,
    codeFontSize: 14,
    codeOutput: "",
    codeRunDelayMs: DEFAULT_CODE_RUN_DELAY_MS,
    codeOutputHoldMs: DEFAULT_CODE_OUTPUT_HOLD_MS,
    codeTypingBeats: [],
  };
}

export type TemplateKind = "text" | "countdown" | "typing" | "codeTyping";
export type TemplateMode = "editable" | "fixed";
export type { FixedTemplatePresetId };

export interface ComposeTemplateDraft {
  /** User chose a template type and entered customize mode. */
  picked: boolean;
  /** Fixed presets are locked; editable allows full customization. */
  mode: TemplateMode;
  fixedPresetId: FixedTemplatePresetId | null;
  templateKind: TemplateKind;
  /** On-screen Excalifont text (label for countdown). */
  text: string;
  textColor: string;
  fontSize: number;
  countdownSec: number;
  script: string;
  title: string;
  audioUrl: string | null;
  durationMs: number;
  ready: boolean;
  /** Live preview data URL (white bg). */
  previewUrl: string | null;
}

export function emptyComposeTemplateDraft(
  kind: TemplateKind = "text",
): ComposeTemplateDraft {
  return {
    picked: false,
    mode: "editable",
    fixedPresetId: null,
    templateKind: kind,
    text: kind === "countdown" ? "Get ready" : "Your headline here",
    textColor: "#1a1a1a",
    fontSize: kind === "countdown" ? 160 : 72,
    countdownSec: 5,
    script: "",
    title: "",
    audioUrl: null,
    durationMs: 0,
    ready: false,
    previewUrl: null,
  };
}

export function fixedTemplateDraftFromPreset(
  id: FixedTemplatePresetId,
  audioUrl: string,
  durationMs: number,
  previewUrl: string | null = null,
): ComposeTemplateDraft {
  const preset = getFixedTemplatePreset(id);
  return {
    picked: true,
    mode: "fixed",
    fixedPresetId: id,
    templateKind: "text",
    text: preset.text,
    textColor: FIXED_TEMPLATE_TEXT_COLOR,
    fontSize: FIXED_TEMPLATE_FONT_SIZE,
    countdownSec: 5,
    script: preset.script,
    title: preset.title,
    audioUrl,
    durationMs,
    ready: durationMs > 0 && !!audioUrl,
    previewUrl,
  };
}

/** Minimum on-screen duration for a saved template countdown scene. */
export function templateSceneMinDurationMs(scene: Pick<Scene, "kind" | "templateKind" | "templateCountdownSec" | "durationMs">): number {
  if (scene.kind !== "template" || scene.templateKind !== "countdown") {
    return scene.durationMs ?? 0;
  }
  return templateCountdownDurationMs(scene.templateCountdownSec);
}

/** Fix stale stitch windows before export / preview playback. */
export function healScenesForExport(scenes: Scene[]): Scene[] {
  return scenes.map((s, i) => {
    s = healCommonBumperScene(s);
    const isLast = i === scenes.length - 1;
    const isCountdown = s.kind === "template" && s.templateKind === "countdown";

    // Stitched parts store hold + slide in startMs/endMs — never shrink those windows.
    if (s.masterAudioUrl != null && s.startMs != null && s.endMs != null) {
      if (isCountdown) {
        const speech = templateCountdownDurationMs(s.templateCountdownSec);
        const healed = { ...s, durationMs: speech };
        if (isLast) {
          healed.endMs = (s.startMs ?? 0) + speech;
        }
        return healed;
      }
      if (s.kind === "question") {
        // Peel intro (+ gap) out of the master clip so countdown hold isn't compressed.
        const windowMs = s.endMs - s.startMs;
        const hold = questionPostSpeechVisualMs(s);
        const transition = isLast ? 0 : sceneTransitionMs(s);
        const clipMs = Math.max(0, windowMs - hold - transition);
        const pre = questionPreQuestionMs(s);
        const mainMs = Math.max(0, clipMs - pre);
        return {
          ...s,
          durationMs: mainMs > 0 ? mainMs : revealSpeechDurationMs(s),
        };
      }
      return { ...s, durationMs: revealSpeechDurationMs(s) };
    }

    const speech = isCountdown
      ? templateCountdownDurationMs(s.templateCountdownSec)
      : revealSpeechDurationMs(s);
    const pre = s.kind === "question" ? questionPreQuestionMs(s) : 0;
    const start = s.startMs ?? 0;
    const tail = isLast && s.kind === "question" ? questionPostSpeechVisualMs(s) : 0;
    const minEnd = start + pre + speech + tail;
    const gap = !isLast ? sceneGapMs(s) : 0;
    return {
      ...s,
      durationMs: speech,
      endMs:
        isCountdown && isLast
          ? minEnd
          : Math.max(s.endMs ?? 0, minEnd + gap),
    };
  });
}

export function templateSceneDurationMs(
  draft: Pick<ComposeTemplateDraft, "templateKind" | "countdownSec" | "durationMs">,
): number {
  if (draft.templateKind !== "countdown") return draft.durationMs;
  return templateCountdownDurationMs(draft.countdownSec);
}

export function composeTemplateDraftToScene(
  draft: ComposeTemplateDraft,
  sceneId?: string,
): Scene | null {
  /** Code typing is saved via composeCodeDraftToScene (kind: "code"). */
  if (draft.templateKind === "codeTyping") return null;
  if (!draft.ready || !draft.audioUrl || draft.durationMs <= 0) return null;
  if (
    (draft.templateKind === "text" || draft.templateKind === "typing") &&
    !draft.text.trim()
  ) {
    return null;
  }
  const countdownSec = Math.max(1, Math.round(draft.countdownSec || 5));
  const durationMs =
    draft.templateKind === "countdown"
      ? templateSceneDurationMs(draft)
      : draft.durationMs;
  const subtitle =
    draft.title.trim() ||
    draft.text.trim().slice(0, 48) ||
    (draft.templateKind === "countdown"
      ? "Countdown"
      : draft.templateKind === "typing"
        ? "Typing text"
        : "Text template");
  return {
    id: sceneId ?? `scene-${Date.now()}`,
    subtitle,
    kind: "template",
    templateKind: draft.templateKind,
    templateText: draft.text.trim(),
    templateColor: draft.textColor || "#1a1a1a",
    templateFontSize: draft.fontSize,
    templateCountdownSec: draft.templateKind === "countdown" ? countdownSec : undefined,
    templateFixedPreset:
      draft.mode === "fixed" && draft.fixedPresetId ? draft.fixedPresetId : undefined,
    backgroundUrl: draft.previewUrl ?? undefined,
    compositeThumbUrl: draft.previewUrl ?? undefined,
    audioUrl: draft.audioUrl,
    durationMs,
    animation: "fade",
    narrationText: draft.script,
    bgAspect: COMPOSITE_ASPECT,
  };
}

export function composeCodeDraftToScene(
  draft: ComposeCodeDraft,
  sceneId?: string,
  opts?: { fromTemplate?: boolean },
): Scene | null {
  const beats = resolveCodeTypingBeats({
    beats: draft.codeTypingBeats,
    code: draft.code,
    output: draft.codeOutput,
    runDelayMs: draft.codeRunDelayMs,
    outputHoldMs: draft.codeOutputHoldMs,
  });
  const fullCode = beats.length ? beatsToFullCode(beats) : draft.code;
  if (!draft.ready || !draft.audioUrl || draft.durationMs <= 0 || !fullCode.trim()) {
    return null;
  }
  const first = beats[0];
  const subtitle =
    draft.title.trim() ||
    draft.script.trim().slice(0, 48) ||
    fullCode.trim().split("\n")[0]?.slice(0, 48) ||
    "Code scene";
  return {
    id: sceneId ?? `scene-${Date.now()}`,
    subtitle,
    kind: "code",
    code: fullCode,
    codeLanguage: draft.codeLanguage,
    codeVariant: draft.codeVariant,
    codeTypingCps: draft.typingSpeedCps,
    codeTypingDefaultsVersion: 2,
    codeFontSize: draft.codeFontSize,
    codeOutput: first?.output?.trim() ? first.output : draft.codeOutput?.trim() || undefined,
    codeRunDelayMs: first?.runDelayMs ?? draft.codeRunDelayMs,
    codeOutputHoldMs: first?.outputHoldMs ?? draft.codeOutputHoldMs,
    codeTypingBeats: beats.length > 0 ? beats : undefined,
    silentNarration: draft.silentNarration === true,
    /** Marks Templates → Code typing so Edit opens that UI, not the Code tab. */
    templateKind: opts?.fromTemplate ? "codeTyping" : undefined,
    audioUrl: draft.audioUrl,
    durationMs: draft.durationMs,
    animation: "fade",
    narrationText: draft.silentNarration ? "" : draft.script,
  };
}

export interface RecordingAudioSegment {
  id: string;
  /** Source TTS in/out (ms on the original audio file). */
  trimStartMs: number;
  trimEndMs: number;
  /** Where this slice starts on the scene timeline (ms). */
  offsetMs: number;
  /** Playback speed 0.5–2 (default 1). Timeline length = source / rate. */
  rate?: number;
}

/** One video slice on the sync timeline (mirrors audio segments). */
export interface RecordingVideoSegment {
  id: string;
  trimStartMs: number;
  trimEndMs: number;
  offsetMs: number;
  /** Playback speed 0.5–2 (default 1). */
  rate?: number;
}

export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 2;
export const DEFAULT_PLAYBACK_RATE = 1;

export function clampPlaybackRate(rate: number | null | undefined): number {
  if (rate == null || !Number.isFinite(rate)) return DEFAULT_PLAYBACK_RATE;
  return Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, rate));
}

export interface ComposeRecordingDraft {
  script: string;
  title: string;
  /** Persisted or blob/data URL of the uploaded recording. */
  mediaUrl: string | null;
  /** Full source video length in ms. */
  sourceDurationMs: number;
  /** @deprecated Prefer videoSegments[0]; kept for legacy dual-write. */
  trimStartMs: number;
  /** @deprecated Prefer videoSegments[0]. */
  trimEndMs: number;
  /** @deprecated Prefer videoSegments[0].offsetMs. */
  videoOffsetMs: number;
  /** Video slices on the timeline (source of truth when non-empty). */
  videoSegments: RecordingVideoSegment[];
  audioUrl: string | null;
  /** Full TTS source length (ms). */
  audioDurationMs: number;
  /** Narration slices on the timeline (source of truth). */
  audioSegments: RecordingAudioSegment[];
  /** Pan/zoom camera keyframes on the scene clock. */
  cameraKeyframes: RecordingCameraKeyframe[];
  /** Duration of each authored zoom move (ms). */
  cameraZoomDurationMs: number;
  /** Zoom move SFX: swoosh or none. */
  cameraZoomSfx: RecordingCameraZoomSfx;
  /**
   * Optional blur region in source-video space (0–1). Tracks through camera zoom.
   */
  blurRegion: RecordingBlurRegion | null;
  /** Timed hand-drawn rectangle highlights (Screen recording 2). */
  highlights: RecordingHighlight[];
  /**
   * When true, audio came from the video itself (clip mode).
   * Skip TTS / sync UI; still stored as a recording scene.
   */
  useEmbeddedAudio: boolean;
  /**
   * When true, audio was auto-replaced via Screen recording 2
   * (STT → clean fillers → local Kokoro → restitch).
   */
  voiceReplace?: boolean;
  /**
   * Screen recording 2 transcript chunks (editable before TTS).
   * Timings come from STT; text is user-editable.
   */
  voicePhrases?: Array<{
    id: string;
    text: string;
    startSec: number;
    endSec: number;
    audioUrl?: string | null;
    audioDurationMs?: number;
  }>;
  ready: boolean;
}

export function newRecordingAudioSegmentId(): string {
  return `aud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function newRecordingVideoSegmentId(): string {
  return `vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function singleRecordingAudioSegment(
  audioDurationMs: number,
  offsetMs = 0,
  rate = DEFAULT_PLAYBACK_RATE,
): RecordingAudioSegment {
  return {
    id: newRecordingAudioSegmentId(),
    trimStartMs: 0,
    trimEndMs: Math.max(0, audioDurationMs),
    offsetMs,
    rate: clampPlaybackRate(rate),
  };
}

export function singleRecordingVideoSegment(
  sourceDurationMs: number,
  offsetMs = 0,
  rate = DEFAULT_PLAYBACK_RATE,
): RecordingVideoSegment {
  return {
    id: newRecordingVideoSegmentId(),
    trimStartMs: 0,
    trimEndMs: Math.max(0, sourceDurationMs),
    offsetMs,
    rate: clampPlaybackRate(rate),
  };
}

export function emptyComposeRecordingDraft(
  opts?: { useEmbeddedAudio?: boolean; voiceReplace?: boolean },
): ComposeRecordingDraft {
  return {
    script: "",
    title: "",
    mediaUrl: null,
    sourceDurationMs: 0,
    trimStartMs: 0,
    trimEndMs: 0,
    videoOffsetMs: 0,
    videoSegments: [],
    audioUrl: null,
    audioDurationMs: 0,
    audioSegments: [],
    cameraKeyframes: normalizeRecordingCameraKeyframes(null),
    cameraZoomDurationMs: DEFAULT_CAMERA_ZOOM_DURATION_MS,
    cameraZoomSfx: DEFAULT_CAMERA_ZOOM_SFX,
    blurRegion: null,
    highlights: [],
    useEmbeddedAudio: opts?.useEmbeddedAudio === true,
    voiceReplace: opts?.voiceReplace === true,
    voicePhrases: opts?.voiceReplace === true ? [] : undefined,
    ready: false,
  };
}

/** Source span of a segment before speed (ms). */
export function recordingSegmentSourceDurationMs(
  seg: Pick<RecordingAudioSegment, "trimStartMs" | "trimEndMs">,
): number {
  return Math.max(0, seg.trimEndMs - seg.trimStartMs);
}

/** Timeline span of a segment after speed (ms). */
export function recordingSegmentDurationMs(
  seg: Pick<RecordingAudioSegment, "trimStartMs" | "trimEndMs" | "rate">,
): number {
  const src = recordingSegmentSourceDurationMs(seg);
  const rate = clampPlaybackRate(seg.rate);
  return Math.max(0, src / rate);
}

/** Visible trimmed span of the recording (ms) — legacy single-clip helper. */
export function recordingTrimmedDurationMs(
  draft: Pick<ComposeRecordingDraft, "trimStartMs" | "trimEndMs" | "sourceDurationMs">,
): number {
  const end =
    draft.trimEndMs > 0
      ? draft.trimEndMs
      : draft.sourceDurationMs > 0
        ? draft.sourceDurationMs
        : 0;
  return Math.max(0, end - Math.max(0, draft.trimStartMs));
}

/** Normalize segments from draft or legacy single-clip scene fields. */
export function normalizeRecordingAudioSegments(input: {
  audioSegments?: RecordingAudioSegment[];
  audioDurationMs?: number;
  audioTrimStartMs?: number;
  audioTrimEndMs?: number;
  audioOffsetMs?: number;
}): RecordingAudioSegment[] {
  if (input.audioSegments?.length) {
    return input.audioSegments.map((s) => ({
      ...s,
      trimStartMs: Math.max(0, s.trimStartMs),
      trimEndMs: Math.max(s.trimStartMs + 1, s.trimEndMs),
      offsetMs: s.offsetMs,
      rate: clampPlaybackRate(s.rate),
    }));
  }
  const audioDurationMs = input.audioDurationMs ?? 0;
  if (audioDurationMs > 0) {
    const trimStart = Math.max(0, input.audioTrimStartMs ?? 0);
    const trimEnd = Math.max(
      trimStart + 1,
      input.audioTrimEndMs && input.audioTrimEndMs > 0
        ? input.audioTrimEndMs
        : audioDurationMs,
    );
    return [
      {
        id: newRecordingAudioSegmentId(),
        trimStartMs: trimStart,
        trimEndMs: trimEnd,
        offsetMs: input.audioOffsetMs ?? 0,
        rate: DEFAULT_PLAYBACK_RATE,
      },
    ];
  }
  return [];
}

export function normalizeRecordingVideoSegments(input: {
  videoSegments?: RecordingVideoSegment[];
  sourceDurationMs?: number;
  trimStartMs?: number;
  trimEndMs?: number;
  videoOffsetMs?: number;
}): RecordingVideoSegment[] {
  if (input.videoSegments?.length) {
    return input.videoSegments.map((s) => ({
      ...s,
      trimStartMs: Math.max(0, s.trimStartMs),
      trimEndMs: Math.max(s.trimStartMs + 1, s.trimEndMs),
      offsetMs: s.offsetMs,
      rate: clampPlaybackRate(s.rate),
    }));
  }
  const sourceDurationMs = input.sourceDurationMs ?? 0;
  if (sourceDurationMs > 0 || (input.trimEndMs ?? 0) > (input.trimStartMs ?? 0)) {
    const trimStart = Math.max(0, input.trimStartMs ?? 0);
    const trimEnd = Math.max(
      trimStart + 1,
      input.trimEndMs && input.trimEndMs > 0 ? input.trimEndMs : sourceDurationMs || trimStart + 1,
    );
    return [
      {
        id: newRecordingVideoSegmentId(),
        trimStartMs: trimStart,
        trimEndMs: trimEnd,
        offsetMs: input.videoOffsetMs ?? 0,
        rate: DEFAULT_PLAYBACK_RATE,
      },
    ];
  }
  return [];
}

/** Dual-write legacy single-clip video fields from the first segment. */
export function legacyVideoFieldsFromSegments(segments: RecordingVideoSegment[]): {
  trimStartMs: number;
  trimEndMs: number;
  videoOffsetMs: number;
  videoSegments: RecordingVideoSegment[];
} {
  const normalized = normalizeRecordingVideoSegments({ videoSegments: segments });
  const first = normalized[0];
  if (!first) {
    return { trimStartMs: 0, trimEndMs: 0, videoOffsetMs: 0, videoSegments: [] };
  }
  return {
    trimStartMs: first.trimStartMs,
    trimEndMs: first.trimEndMs,
    videoOffsetMs: first.offsetMs,
    videoSegments: normalized,
  };
}

/**
 * On-screen scene length: cover all narration slices and the video window.
 */
export function recordingSceneDurationMs(opts: {
  audioSegments?: RecordingAudioSegment[];
  audioTrimStartMs?: number;
  audioTrimEndMs?: number;
  audioDurationMs?: number;
  audioOffsetMs?: number;
  videoSegments?: RecordingVideoSegment[];
  trimStartMs: number;
  trimEndMs: number;
  sourceDurationMs: number;
  videoOffsetMs: number;
}): number {
  const audioSegments = normalizeRecordingAudioSegments({
    audioSegments: opts.audioSegments,
    audioDurationMs: opts.audioDurationMs ?? 0,
    audioTrimStartMs: opts.audioTrimStartMs,
    audioTrimEndMs: opts.audioTrimEndMs,
    audioOffsetMs: opts.audioOffsetMs,
  });
  let audioEnd = 0;
  for (const s of audioSegments) {
    audioEnd = Math.max(audioEnd, s.offsetMs + recordingSegmentDurationMs(s));
  }
  const videoSegments = normalizeRecordingVideoSegments({
    videoSegments: opts.videoSegments,
    sourceDurationMs: opts.sourceDurationMs,
    trimStartMs: opts.trimStartMs,
    trimEndMs: opts.trimEndMs,
    videoOffsetMs: opts.videoOffsetMs,
  });
  let videoEnd = 0;
  for (const s of videoSegments) {
    videoEnd = Math.max(videoEnd, s.offsetMs + recordingSegmentDurationMs(s));
  }
  return Math.max(1, audioEnd, videoEnd);
}

/** Split the audio segment under the playhead into two contiguous source slices. */
export function splitRecordingAudioAtClock(
  segments: RecordingAudioSegment[],
  clockMs: number,
  minPartMs = 200,
): RecordingAudioSegment[] | null {
  const sorted = [...segments].sort((a, b) => a.offsetMs - b.offsetMs);
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]!;
    const dur = recordingSegmentDurationMs(seg);
    const local = clockMs - seg.offsetMs;
    if (local <= minPartMs || local >= dur - minPartMs) continue;
    const rate = clampPlaybackRate(seg.rate);
    const splitSource = seg.trimStartMs + local * rate;
    const left: RecordingAudioSegment = {
      ...seg,
      trimEndMs: splitSource,
      rate,
    };
    const right: RecordingAudioSegment = {
      id: newRecordingAudioSegmentId(),
      trimStartMs: splitSource,
      trimEndMs: seg.trimEndMs,
      offsetMs: clockMs,
      rate,
    };
    return [...sorted.slice(0, i), left, right, ...sorted.slice(i + 1)];
  }
  return null;
}

/** Split the video segment under the playhead (same rules as audio). */
export function splitRecordingVideoAtClock(
  segments: RecordingVideoSegment[],
  clockMs: number,
  minPartMs = 200,
): RecordingVideoSegment[] | null {
  const sorted = [...segments].sort((a, b) => a.offsetMs - b.offsetMs);
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]!;
    const dur = recordingSegmentDurationMs(seg);
    const local = clockMs - seg.offsetMs;
    if (local <= minPartMs || local >= dur - minPartMs) continue;
    const rate = clampPlaybackRate(seg.rate);
    const splitSource = seg.trimStartMs + local * rate;
    const left: RecordingVideoSegment = {
      ...seg,
      trimEndMs: splitSource,
      rate,
    };
    const right: RecordingVideoSegment = {
      id: newRecordingVideoSegmentId(),
      trimStartMs: splitSource,
      trimEndMs: seg.trimEndMs,
      offsetMs: clockMs,
      rate,
    };
    return [...sorted.slice(0, i), left, right, ...sorted.slice(i + 1)];
  }
  return null;
}

export function composeRecordingDraftToScene(
  draft: ComposeRecordingDraft,
  sceneId?: string,
): Scene | null {
  if (
    !draft.ready ||
    !draft.audioUrl ||
    draft.audioDurationMs <= 0 ||
    !draft.mediaUrl ||
    draft.sourceDurationMs <= 0
  ) {
    return null;
  }
  const audioSegments = normalizeRecordingAudioSegments(draft);
  if (audioSegments.length === 0) return null;
  const videoSegments = normalizeRecordingVideoSegments(draft);
  if (videoSegments.length === 0) return null;
  const legacyVideo = legacyVideoFieldsFromSegments(videoSegments);

  const durationMs = recordingSceneDurationMs({
    audioSegments,
    audioDurationMs: draft.audioDurationMs,
    videoSegments,
    trimStartMs: legacyVideo.trimStartMs,
    trimEndMs: legacyVideo.trimEndMs,
    sourceDurationMs: draft.sourceDurationMs,
    videoOffsetMs: legacyVideo.videoOffsetMs,
  });
  const first = audioSegments[0]!;
  const subtitle =
    draft.title.trim() ||
    draft.script.trim().slice(0, 48) ||
    (draft.useEmbeddedAudio
      ? "Video clip"
      : draft.voiceReplace
        ? "Screen recording 2"
        : "Screen recording");
  return {
    id: sceneId ?? `scene-${Date.now()}`,
    subtitle,
    kind: "recording",
    mediaUrl: draft.mediaUrl,
    recordingTrimStartMs: legacyVideo.trimStartMs,
    recordingTrimEndMs: legacyVideo.trimEndMs,
    recordingVideoOffsetMs: legacyVideo.videoOffsetMs,
    recordingSourceDurationMs: draft.sourceDurationMs,
    recordingVideoSegments: videoSegments,
    recordingAudioTrimStartMs: first.trimStartMs,
    recordingAudioTrimEndMs: first.trimEndMs,
    recordingAudioOffsetMs: first.offsetMs,
    recordingAudioSourceDurationMs: draft.audioDurationMs,
    recordingAudioSegments: audioSegments,
    recordingCameraKeyframes: normalizeRecordingCameraKeyframes(draft.cameraKeyframes),
    recordingCameraZoomDurationMs: clampCameraZoomDurationMs(draft.cameraZoomDurationMs),
    recordingCameraZoomSfx: normalizeRecordingCameraZoomSfx(draft.cameraZoomSfx),
    recordingBlurRegion: normalizeRecordingBlurRegion(draft.blurRegion) ?? undefined,
    recordingHighlights: (() => {
      const list = normalizeRecordingHighlights(draft.highlights);
      return list.length ? list : undefined;
    })(),
    recordingUseEmbeddedAudio: draft.useEmbeddedAudio || undefined,
    recordingVoiceReplace: draft.voiceReplace === true ? true : undefined,
    audioUrl: draft.audioUrl,
    durationMs,
    animation: "fade",
    narrationText: draft.script,
  };
}

export function sceneToRecordingDraft(scene: Scene): ComposeRecordingDraft | null {
  if (scene.kind !== "recording" || !scene.mediaUrl) return null;
  const sourceDurationMs =
    scene.recordingSourceDurationMs ??
    Math.max(
      scene.recordingTrimEndMs ?? 0,
      scene.durationMs ?? 0,
    );
  const videoSegments = normalizeRecordingVideoSegments({
    videoSegments: scene.recordingVideoSegments,
    sourceDurationMs,
    trimStartMs: scene.recordingTrimStartMs ?? 0,
    trimEndMs: scene.recordingTrimEndMs ?? sourceDurationMs,
    videoOffsetMs: scene.recordingVideoOffsetMs ?? 0,
  });
  const legacyVideo = legacyVideoFieldsFromSegments(videoSegments);
  const audioDurationMs =
    scene.recordingAudioSourceDurationMs ?? scene.durationMs ?? 0;
  const audioSegments =
    scene.recordingAudioSegments?.length
      ? scene.recordingAudioSegments.map((s) => ({
          ...s,
          rate: clampPlaybackRate(s.rate),
        }))
      : audioDurationMs > 0
        ? [
            {
              id: newRecordingAudioSegmentId(),
              trimStartMs: scene.recordingAudioTrimStartMs ?? 0,
              trimEndMs: scene.recordingAudioTrimEndMs ?? audioDurationMs,
              offsetMs: scene.recordingAudioOffsetMs ?? 0,
              rate: DEFAULT_PLAYBACK_RATE,
            },
          ]
        : [];
  return {
    script: scene.narrationText ?? "",
    title: scene.subtitle ?? "",
    mediaUrl: scene.mediaUrl,
    sourceDurationMs,
    trimStartMs: legacyVideo.trimStartMs,
    trimEndMs: legacyVideo.trimEndMs,
    videoOffsetMs: legacyVideo.videoOffsetMs,
    videoSegments: legacyVideo.videoSegments,
    audioUrl: scene.audioUrl || null,
    audioDurationMs,
    audioSegments,
    cameraKeyframes: normalizeRecordingCameraKeyframes(scene.recordingCameraKeyframes),
    cameraZoomDurationMs: clampCameraZoomDurationMs(
      scene.recordingCameraZoomDurationMs ?? DEFAULT_CAMERA_ZOOM_DURATION_MS,
    ),
    cameraZoomSfx: normalizeRecordingCameraZoomSfx(scene.recordingCameraZoomSfx),
    blurRegion: normalizeRecordingBlurRegion(scene.recordingBlurRegion),
    highlights: normalizeRecordingHighlights(scene.recordingHighlights),
    useEmbeddedAudio: scene.recordingUseEmbeddedAudio === true,
    voiceReplace: scene.recordingVoiceReplace === true,
    ready: !!scene.audioUrl && audioDurationMs > 0,
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
    transitionEffect: _te,
    ...rest
  } = scene;
  return rest;
}

export function sceneSourceMode(scene: Scene): ComposeSourceMode {
  /** Template → Code typing is stored as kind "code" but must edit in Templates. */
  if (scene.kind === "code" && isTemplateCodeTypingScene(scene)) return "template";
  if (scene.kind === "code") return "code";
  if (scene.kind === "question") return "question";
  if (scene.kind === "template") return "template";
  if (scene.kind === "recording") {
    if (scene.recordingVoiceReplace) return "recording2";
    return scene.recordingUseEmbeddedAudio ? "clip" : "recording";
  }
  return "upload";
}

/** Scenes created from Templates → Code typing (not the Code tab). */
export function isTemplateCodeTypingScene(scene: Scene): boolean {
  if (scene.kind !== "code") return false;
  if (scene.templateKind === "codeTyping") return true;
  if ((scene.codeVariant ?? "typing") !== "typing") return false;
  const hasBeats = !!(scene.codeTypingBeats && scene.codeTypingBeats.length > 0);
  const hasOutput = !!(scene.codeOutput && scene.codeOutput.trim());
  if (!hasBeats && !hasOutput) return false;
  /** Backward compat: silent code typing from templates. */
  if (scene.silentNarration === true) return true;
  /**
   * Older template scenes were saved without the silentNarration flag.
   * Code-tab scenes always carry narration text / script; template code
   * typing never does, so treat narration-less beat scenes as templates.
   */
  const narration = (scene.narrationText ?? "").trim();
  const script = ((scene as { script?: string }).script ?? "").trim();
  return narration.length === 0 && script.length === 0;
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
  const silent =
    scene.silentNarration === true ||
    (!(scene.narrationText ?? "").trim() && (scene.codeVariant ?? "typing") === "typing");
  const beats = resolveCodeTypingBeats({
    beats: scene.codeTypingBeats,
    code: scene.code,
    output: scene.codeOutput,
    runDelayMs: scene.codeRunDelayMs,
    outputHoldMs: scene.codeOutputHoldMs,
  });
  const first = beats[0];
  const isTemplateCodeTyping = isTemplateCodeTypingScene(scene);
  // Legacy template scenes stored the old global defaults (28 cps, 0.7s delay,
  // "example.<lang>" title). Map those to the new Template → Code typing defaults;
  // values the user actually changed are preserved.
  const rawBeats = scene.codeTypingBeats;
  const normBeats = isTemplateCodeTyping
    ? beats.map((b, i) =>
        b.runDelayMs === DEFAULT_CODE_RUN_DELAY_MS &&
        (rawBeats?.[i]?.runDelayMs == null ||
          rawBeats[i]!.runDelayMs === DEFAULT_CODE_RUN_DELAY_MS)
          ? { ...b, runDelayMs: TEMPLATE_CODE_RUN_DELAY_MS }
          : b,
      )
    : beats;
  const normFirst = normBeats[0];
  const rawTitle = (scene.subtitle ?? "").trim();
  const title = isTemplateCodeTyping
    ? !rawTitle || /^example\.[a-z]+$/i.test(rawTitle)
      ? TEMPLATE_CODE_TITLE
      : scene.subtitle
    : scene.subtitle;
  const cps = scene.codeTypingCps;
  const usesLegacyTypingDefault =
    scene.codeTypingDefaultsVersion !== 2 && cps === LEGACY_CODE_TYPING_CPS;
  const typingSpeedCps = isTemplateCodeTyping
    ? cps == null || usesLegacyTypingDefault
      ? TEMPLATE_CODE_TYPING_CPS
      : cps
    : (cps == null || usesLegacyTypingDefault ? DEFAULT_CODE_TYPING_CPS : cps);
  const legacyRunDelay = scene.codeRunDelayMs;
  const runDelayFallback =
    isTemplateCodeTyping &&
    (legacyRunDelay == null || legacyRunDelay === DEFAULT_CODE_RUN_DELAY_MS)
      ? TEMPLATE_CODE_RUN_DELAY_MS
      : (legacyRunDelay ?? DEFAULT_CODE_RUN_DELAY_MS);
  return {
    script: scene.narrationText ?? "",
    code: normBeats.length ? beatsToFullCode(normBeats) : (scene.code ?? ""),
    codeLanguage: scene.codeLanguage ?? "py",
    codeVariant: scene.codeVariant ?? "typing",
    title,
    audioUrl: scene.audioUrl,
    durationMs: scene.durationMs,
    ready: !!scene.audioUrl && scene.durationMs > 0,
    silentNarration: silent,
    typingSpeedCps,
    defaultsVersion: 2,
    codeFontSize: scene.codeFontSize ?? 14,
    codeOutput: normFirst?.output ?? scene.codeOutput ?? "",
    codeRunDelayMs: normFirst?.runDelayMs ?? runDelayFallback,
    codeOutputHoldMs:
      normFirst?.outputHoldMs ?? scene.codeOutputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS,
    codeTypingBeats: normBeats,
  };
}

export function sceneToTemplateDraft(scene: Scene): ComposeTemplateDraft | null {
  if (isTemplateCodeTypingScene(scene)) {
    return {
      picked: true,
      mode: "editable",
      fixedPresetId: null,
      templateKind: "codeTyping",
      text: "",
      textColor: "#1a1a1a",
      fontSize: 72,
      countdownSec: 5,
      script: "",
      title: scene.subtitle ?? "",
      audioUrl: scene.audioUrl,
      durationMs: scene.durationMs,
      ready: !!scene.audioUrl && scene.durationMs > 0,
      previewUrl: null,
    };
  }
  if (scene.kind !== "template") return null;
  const templateKind: TemplateKind =
    scene.templateKind === "countdown"
      ? "countdown"
      : scene.templateKind === "typing"
        ? "typing"
        : "text";
  const countdownSec = scene.templateCountdownSec ?? 5;
  const isFixed = !!scene.templateFixedPreset;
  return {
    picked: true,
    mode: isFixed ? "fixed" : "editable",
    fixedPresetId: scene.templateFixedPreset ?? null,
    templateKind,
    text: scene.templateText ?? "",
    textColor: scene.templateColor ?? "#1a1a1a",
    fontSize: scene.templateFontSize ?? 72,
    countdownSec,
    script: scene.narrationText ?? "",
    title: scene.subtitle ?? "",
    audioUrl: scene.audioUrl,
    durationMs:
      templateKind === "countdown"
        ? templateCountdownDurationMs(countdownSec)
        : scene.durationMs,
    ready: !!scene.audioUrl && scene.durationMs > 0,
    previewUrl: scene.compositeThumbUrl ?? scene.backgroundUrl ?? null,
  };
}

export function sceneToQuestionDraft(scene: Scene): ComposeQuestionDraft | null {
  if (scene.kind !== "question") return null;
  const opts = scene.questionOptions ?? ["", "", "", ""];
  const kind = scene.questionKind ?? "mcq";
  const isCoding = kind === "coding";
  const isPredict = kind === "predictOutput";
  const markText =
    scene.questionMarkText?.trim() ||
    (isCoding ? CODING_MARK_SCREEN_TEXT_DEFAULT : QUESTION_MARK_SCREEN_TEXT_DEFAULT);
  const introText =
    scene.questionIntroText?.trim() ||
    (isCoding ? CODING_INTRO_SCREEN_TEXT_DEFAULT : QUESTION_INTRO_SCREEN_TEXT_DEFAULT);
  const tests = emptyCodingTestCases();
  (scene.codingTestCases ?? []).slice(0, 3).forEach((t, i) => {
    tests[i] = {
      label: t.label ?? `Case ${i + 1}`,
      input: t.input ?? "",
      output: t.output ?? "",
    };
  });
  return {
    kind,
    question: scene.questionText ?? "",
    subtitle:
      scene.questionSubtitle ??
      (isCoding ? "Coding Problem" : isPredict ? "Predict output" : "Question"),
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
    markDurationMs: scene.questionMarkDurationMs ?? 0,
    introText,
    introGapSec: (scene.questionIntroGapMs ?? QUESTION_INTRO_GAP_MS) / 1000,
    introAudioUrl: scene.questionIntroAudioUrl ?? null,
    introDurationMs: scene.questionIntroDurationMs ?? 0,
    introAudioForText: introText,
    codingTitle: scene.codingTitle ?? (isCoding ? scene.questionSubtitle ?? "" : ""),
    codingStarterCode: scene.codingStarterCode ?? "",
    codingPaste: "",
    codingTestCases: tests,
    predictCode: scene.questionCode ?? "",
    predictSelectMode: scene.predictSelectMode === "msq" ? "msq" : "mcq",
  };
}
