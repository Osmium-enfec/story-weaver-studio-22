import { createClientId } from "@/lib/client-id";
import type { Scene } from "@/components/VideoPlayer";

/** Part script planning (Compose → Script tab). */

import {
  COMMON_INTRO_DURATION_MS,
  COMMON_INTRO_VIDEO_URL,
  COMMON_OUTRO_DURATION_MS,
  COMMON_OUTRO_VIDEO_URL,
  isCommonIntroOutroMediaUrl,
} from "@/lib/common-intro-outro";

export type PartScriptSceneType =
  | "unset"
  | "intro"
  | "outro"
  | "image"
  | "recording2"
  | "clip"
  | "question"
  | "template"
  | "coding";

/** Top-level types shown in the scene-type dropdown (excludes unset placeholder). */
export const PART_SCRIPT_SCENE_TYPES: Array<Exclude<PartScriptSceneType, "unset">> = [
  "intro",
  "outro",
  "image",
  "recording2",
  "clip",
  "question",
  "template",
  "coding",
];

export const PART_SCRIPT_TYPE_LABELS: Record<PartScriptSceneType, string> = {
  unset: "Select scene type",
  intro: "Intro",
  outro: "Outro",
  image: "Upload image",
  recording2: "Screen recording",
  clip: "Video clip",
  question: "Questions",
  template: "Template",
  coding: "Coding",
};

export type PartScriptQuestionSubtype = "mcq" | "msq" | "coding" | "predictOutput";

export const PART_SCRIPT_QUESTION_SUBTYPES: PartScriptQuestionSubtype[] = [
  "mcq",
  "msq",
  "coding",
  "predictOutput",
];

export const PART_SCRIPT_QUESTION_SUBTYPE_LABELS: Record<
  PartScriptQuestionSubtype,
  string
> = {
  mcq: "MCQ",
  msq: "MSQ",
  coding: "Coding problem",
  predictOutput: "Predict output",
};

export type PartScriptTemplateSubtype = "text" | "typing" | "codeTyping";

export const PART_SCRIPT_TEMPLATE_SUBTYPES: PartScriptTemplateSubtype[] = [
  "text",
  "typing",
  "codeTyping",
];

export const PART_SCRIPT_TEMPLATE_SUBTYPE_LABELS: Record<
  PartScriptTemplateSubtype,
  string
> = {
  text: "Text card",
  typing: "Typing text",
  codeTyping: "Code typing",
};

/** @deprecated Kept for older saved plans / AI generator. */
export type PartScriptQuestionKind = "mcq" | "msq";

export interface PartScriptQuestion {
  kind: PartScriptQuestionKind;
  question: string;
  options: [string, string, string, string];
  correct: string;
}

export interface PartScriptScene {
  id: string;
  name: string;
  type: PartScriptSceneType;
  /** When type === "question". */
  questionSubtype?: PartScriptQuestionSubtype;
  /** When type === "template". */
  templateSubtype?: PartScriptTemplateSubtype;
  /** Narration / spoken script. */
  script: string;
  audioUrl?: string | null;
  durationMs?: number;
  /** Upload-image scene. */
  imageUrl?: string | null;
  /** Screen recording / video clip media. */
  mediaUrl?: string | null;
  mediaDurationMs?: number;
  /** Raw MCQ/MSQ paste (AI fills structured fields later). */
  questionPaste?: string;
  /** Raw coding-problem paste (same format as Questions → coding). */
  codingPaste?: string;
  /** Template text card / typing text. */
  templateText?: string;
  /** Template code typing / optional code. */
  code?: string;
  /** Stepwise code-typing beats (template code typing, no narration). */
  codeTypingBeats?: {
    id: string;
    code: string;
    output: string;
    outputHoldMs: number;
    runDelayMs: number;
  }[];
  /** Legacy fields (older plans). */
  imagePrompt?: string;
  screen?: string;
  expectedOutput?: string;
  scriptAfter?: string;
  placeholderNote?: string;
  question?: PartScriptQuestion;
  practiceBrief?: string;
}

export interface PartScriptPlan {
  scenes: PartScriptScene[];
}

export type PartScriptComposeMode =
  | "upload"
  | "code"
  | "clip"
  | "recording2"
  | "question"
  | "template";

/** Map a script scene to the Compose top-bar mode. */
export function composeModeForPartScriptType(
  scene: Pick<PartScriptScene, "type" | "templateSubtype">,
): PartScriptComposeMode {
  /** Template → Code typing is sometimes stored with type "coding". */
  if (scene.templateSubtype === "codeTyping") return "template";
  switch (scene.type) {

    case "intro":
    case "outro":
      return "clip";
    case "image":
      return "upload";
    case "recording2":
      return "recording2";
    case "clip":
      return "clip";
    case "question":
      return "question";
    case "template":
      return "template";
    case "coding":
      return "code";
    case "unset":
    default:
      return "upload";
  }
}

export const PART_SCRIPT_WPM = 135;
export const PART_SCRIPT_MIN_MS = 7 * 60 * 1000;
export const PART_SCRIPT_MAX_MS = 14 * 60 * 1000;

export function newPartScriptSceneId(): string {
  return createClientId();
}

/** Mint a compose/stitch scene id (always `scene-…`). */
export function newComposeSceneId(): string {
  return `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function scriptSceneIdForCompose(composeId: string): string {
  return `script_${composeId}`;
}

/** Extract compose id from a linked script row id (`script_scene-…`). */
export function composeIdFromScriptSceneId(scriptId: string): string | null {
  if (!scriptId.startsWith("script_scene-")) return null;
  return scriptId.slice("script_".length);
}

export function isLinkedScriptSceneId(scriptId: string): boolean {
  return composeIdFromScriptSceneId(scriptId) != null;
}

function kindForPartScriptType(type: PartScriptSceneType): Scene["kind"] {
  switch (type) {
    case "intro":
    case "outro":
    case "recording2":
    case "clip":
      return "recording";
    case "question":
      return "question";
    case "template":
      return "template";
    case "coding":
      return "code";
    case "unset":
    case "image":
    default:
      return "image";
  }
}

function subtitleForPartScriptType(
  type: PartScriptSceneType,
  name: string,
  index: number,
): string {
  if (type === "intro") return "Intro";
  if (type === "outro") return "Outro";
  const trimmed = name.trim();
  if (trimmed && !/^Scene\s+\d+$/i.test(trimmed)) return trimmed;
  return `Scene ${index}`;
}

/** Build a Script-tab row (optionally already linked to a compose id). */
export function emptyPartScriptScene(
  type: PartScriptSceneType = "unset",
  index = 1,
  composeId?: string,
): PartScriptScene {
  const id = composeId
    ? scriptSceneIdForCompose(composeId)
    : newPartScriptSceneId();
  const base: PartScriptScene = {
    id,
    name: `Scene ${index}`,
    type,
    script: "",
    audioUrl: null,
    durationMs: 0,
  };
  if (type === "image") base.imageUrl = null;
  if (type === "intro") {
    base.mediaUrl = COMMON_INTRO_VIDEO_URL;
    base.mediaDurationMs = COMMON_INTRO_DURATION_MS;
  }
  if (type === "outro") {
    base.mediaUrl = COMMON_OUTRO_VIDEO_URL;
    base.mediaDurationMs = COMMON_OUTRO_DURATION_MS;
  }
  if (type === "recording2" || type === "clip") {
    base.mediaUrl = null;
    base.mediaDurationMs = 0;
  }
  if (type === "question") {
    base.questionSubtype = "mcq";
    base.questionPaste = "";
  }
  if (type === "template") {
    base.templateSubtype = "text";
    base.templateText = "";
  }
  if (type === "coding") {
    base.code = "";
    base.codeTypingBeats = [];
  }
  return base;
}

/** Incomplete stitch placeholder for a Script row (visible, not stitchable). */
export function composeStubFromScriptScene(
  script: PartScriptScene,
  composeId: string,
  index = 1,
): Scene {
  const kind = kindForPartScriptType(script.type);
  const subtitle = subtitleForPartScriptType(script.type, script.name, index);
  const stub: Scene = {
    id: composeId,
    subtitle,
    kind,
    audioUrl: "",
    durationMs: 0,
    animation: "fade",
    narrationText: script.script?.trim() || undefined,
  };
  if ((script.type === "recording2" || script.type === "clip") && script.mediaUrl) {
    stub.mediaUrl = script.mediaUrl;
  }
  if (script.type === "clip") {
    stub.recordingUseEmbeddedAudio = true;
    stub.recordingVoiceReplace = false;
  }
  if (script.type === "recording2") {
    stub.recordingVoiceReplace = true;
    stub.recordingUseEmbeddedAudio = false;
  }
  if (script.type === "image" && script.imageUrl) {
    stub.backgroundUrl = script.imageUrl;
    stub.compositeThumbUrl = script.imageUrl;
  }
  if (script.type === "question" && script.questionSubtype) {
    stub.questionKind = script.questionSubtype;
  }
  if (script.type === "template" && script.templateSubtype) {
    stub.templateKind =
      script.templateSubtype === "codeTyping"
        ? "codeTyping"
        : script.templateSubtype === "typing"
          ? "typing"
          : "text";
  }
  return stub;
}

/** Create a Script row + matching incomplete Stitch stub (strict 1:1 link). */
export function createLinkedScriptAndComposeScene(
  type: PartScriptSceneType = "unset",
  index = 1,
): { scriptScene: PartScriptScene; composeScene: Scene; composeId: string } {
  const composeId = newComposeSceneId();
  const scriptScene = emptyPartScriptScene(type, index, composeId);
  const composeScene = composeStubFromScriptScene(scriptScene, composeId, index);
  return { scriptScene, composeScene, composeId };
}

export function emptyPartScriptPlan(): PartScriptPlan {
  return { scenes: [] };
}

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function partScriptSpokenText(plan: PartScriptPlan): string {
  return plan.scenes
    .map((s) => [s.script, s.scriptAfter].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n");
}

export function estimatePartScriptDurationMs(plan: PartScriptPlan): number {
  const words = wordCount(partScriptSpokenText(plan));
  if (words <= 0) return 0;
  return Math.round((words / PART_SCRIPT_WPM) * 60_000);
}

export function formatDurationMinutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

export function questionToPasteText(q: PartScriptQuestion): string {
  const kindLine = q.kind === "msq" ? "Select all that apply." : "Select one.";
  return [
    q.question.trim(),
    kindLine,
    `A) ${q.options[0] ?? ""}`,
    `B) ${q.options[1] ?? ""}`,
    `C) ${q.options[2] ?? ""}`,
    `D) ${q.options[3] ?? ""}`,
    `Correct: ${q.correct.trim()}`,
  ].join("\n");
}

export function partScriptPlanToText(plan: PartScriptPlan): string {
  return plan.scenes
    .map((s, i) => {
      const title = s.name.trim() || `Scene ${i + 1}`;
      const typeLabel = PART_SCRIPT_TYPE_LABELS[s.type];
      const lines: string[] = [`[${title}] (${typeLabel})`];
      if (s.questionSubtype) {
        lines.push(`Question type: ${PART_SCRIPT_QUESTION_SUBTYPE_LABELS[s.questionSubtype]}`);
      }
      if (s.templateSubtype) {
        lines.push(`Template: ${PART_SCRIPT_TEMPLATE_SUBTYPE_LABELS[s.templateSubtype]}`);
      }
      if (s.questionPaste?.trim()) lines.push(`Question:\n${s.questionPaste.trim()}`);
      if (s.codingPaste?.trim()) lines.push(`Coding problem:\n${s.codingPaste.trim()}`);
      if (s.templateText?.trim()) lines.push(`Text:\n${s.templateText.trim()}`);
      if (s.script.trim()) lines.push(`Narration:\n${s.script.trim()}`);
      if (s.code?.trim()) lines.push(`Code:\n${s.code.trim()}`);
      if (s.question) lines.push(questionToPasteText(s.question));
      return lines.join("\n");
    })
    .join("\n\n")
    .trim();
}

export function partScriptPlanHasContent(plan: PartScriptPlan): boolean {
  return plan.scenes.some((s) => {
    if (s.script.trim()) return true;
    if (s.audioUrl || s.imageUrl || s.mediaUrl) return true;
    if (s.questionPaste?.trim() || s.codingPaste?.trim() || s.templateText?.trim()) {
      return true;
    }
    if (s.code?.trim()) return true;
    if (s.codeTypingBeats?.some((b) => b.code.trim() || b.output.trim())) return true;
    if (s.name.trim() && !/^Scene\s+\d+$/i.test(s.name.trim())) return true;
    if (s.type === "intro" || s.type === "outro") return true;
    return false;
  });
}

function isSceneType(v: unknown): v is PartScriptSceneType {
  if (typeof v !== "string") return false;
  if (v === "unset") return true;
  return (PART_SCRIPT_SCENE_TYPES as string[]).includes(v);
}

function migrateLegacyType(raw: string): {
  type: PartScriptSceneType;
  questionSubtype?: PartScriptQuestionSubtype;
  templateSubtype?: PartScriptTemplateSubtype;
} {
  if (isSceneType(raw)) return { type: raw };
  switch (raw) {
    case "finalCodeTyping":
      return { type: "outro" };
    case "codingPractice":
      return { type: "question", questionSubtype: "coding" };
    case "codeTyping":
      return { type: "template", templateSubtype: "codeTyping" };
    default:
      return { type: "intro" };
  }
}

function normalizeQuestion(raw: unknown): PartScriptQuestion | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const q = raw as Record<string, unknown>;
  const kind = q.kind === "msq" ? "msq" : q.kind === "mcq" ? "mcq" : null;
  if (!kind) return undefined;
  const optionsRaw = Array.isArray(q.options) ? q.options.map(String) : [];
  if (optionsRaw.length < 4) return undefined;
  return {
    kind,
    question: String(q.question ?? ""),
    options: [
      optionsRaw[0] ?? "",
      optionsRaw[1] ?? "",
      optionsRaw[2] ?? "",
      optionsRaw[3] ?? "",
    ],
    correct: String(q.correct ?? ""),
  };
}

export function normalizePartScriptScene(raw: unknown): PartScriptScene | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.name !== "string") return null;
  const migrated = migrateLegacyType(typeof s.type === "string" ? s.type : "intro");
  const scene: PartScriptScene = {
    id: s.id || newPartScriptSceneId(),
    name: s.name,
    type: migrated.type,
    script: typeof s.script === "string" ? s.script : "",
  };
  if (migrated.questionSubtype) scene.questionSubtype = migrated.questionSubtype;
  if (migrated.templateSubtype) scene.templateSubtype = migrated.templateSubtype;

  if (
    s.questionSubtype === "mcq" ||
    s.questionSubtype === "msq" ||
    s.questionSubtype === "coding" ||
    s.questionSubtype === "predictOutput"
  ) {
    scene.questionSubtype = s.questionSubtype;
  }
  if (
    s.templateSubtype === "text" ||
    s.templateSubtype === "typing" ||
    s.templateSubtype === "codeTyping"
  ) {
    scene.templateSubtype = s.templateSubtype;
  }

  if (typeof s.audioUrl === "string") scene.audioUrl = s.audioUrl;
  else if (s.audioUrl === null) scene.audioUrl = null;
  if (typeof s.durationMs === "number") scene.durationMs = s.durationMs;
  if (typeof s.imageUrl === "string") scene.imageUrl = s.imageUrl;
  else if (s.imageUrl === null) scene.imageUrl = null;
  if (typeof s.mediaUrl === "string") scene.mediaUrl = s.mediaUrl;
  else if (s.mediaUrl === null) scene.mediaUrl = null;
  if (typeof s.mediaDurationMs === "number") scene.mediaDurationMs = s.mediaDurationMs;
  if (scene.type === "intro" && !scene.mediaUrl) {
    scene.mediaUrl = COMMON_INTRO_VIDEO_URL;
    scene.mediaDurationMs = COMMON_INTRO_DURATION_MS;
  }
  if (scene.type === "outro" && !scene.mediaUrl) {
    scene.mediaUrl = COMMON_OUTRO_VIDEO_URL;
    scene.mediaDurationMs = COMMON_OUTRO_DURATION_MS;
  }
  if (typeof s.questionPaste === "string") scene.questionPaste = s.questionPaste;
  if (typeof s.codingPaste === "string") scene.codingPaste = s.codingPaste;
  if (typeof s.templateText === "string") scene.templateText = s.templateText;
  if (typeof s.code === "string") scene.code = s.code;
  if (Array.isArray(s.codeTypingBeats)) {
    scene.codeTypingBeats = s.codeTypingBeats
      .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
      .map((b, i) => ({
        id: typeof b.id === "string" ? b.id : `beat-${i}`,
        code: typeof b.code === "string" ? b.code : "",
        output: typeof b.output === "string" ? b.output : "",
        outputHoldMs:
          typeof b.outputHoldMs === "number" ? b.outputHoldMs : 2500,
        runDelayMs: typeof b.runDelayMs === "number" ? b.runDelayMs : 700,
      }));
  }
  if (typeof s.imagePrompt === "string") scene.imagePrompt = s.imagePrompt;
  if (typeof s.screen === "string") scene.screen = s.screen;
  if (typeof s.expectedOutput === "string") scene.expectedOutput = s.expectedOutput;
  if (typeof s.scriptAfter === "string") scene.scriptAfter = s.scriptAfter;
  if (typeof s.placeholderNote === "string") scene.placeholderNote = s.placeholderNote;
  if (typeof s.practiceBrief === "string") scene.practiceBrief = s.practiceBrief;
  const q = normalizeQuestion(s.question);
  if (q) {
    scene.question = q;
    if (!scene.questionSubtype) {
      scene.questionSubtype = q.kind === "msq" ? "msq" : "mcq";
    }
    if (!scene.questionPaste?.trim() && q.question.trim()) {
      scene.questionPaste = questionToPasteText(q);
    }
  }
  if (scene.type === "question" && !scene.questionSubtype) scene.questionSubtype = "mcq";
  if (scene.type === "template" && !scene.templateSubtype) scene.templateSubtype = "text";
  return scene;
}

export function partScriptPlanFromPart(part: {
  script?: string;
  scriptScenes?: unknown;
  scenes?: unknown;
} | null | undefined): PartScriptPlan {
  let plan: PartScriptPlan | null = null;
  if (part?.scriptScenes && Array.isArray(part.scriptScenes) && part.scriptScenes.length > 0) {
    const scenes = part.scriptScenes
      .map(normalizePartScriptScene)
      .filter((s): s is PartScriptScene => s != null);
    if (scenes.length > 0) plan = { scenes };
  }
  if (!plan && part?.script?.trim()) {
    plan = {
      scenes: [
        {
          id: newPartScriptSceneId(),
          name: "Scene 1",
          type: "intro",
          script: part.script,
        },
      ],
    };
  }
  if (!plan) plan = emptyPartScriptPlan();

  const composeScenes = Array.isArray(part?.scenes) ? (part.scenes as Scene[]) : [];
  // On load, stitch can seed order / missing rows; then materialize stubs.
  return alignScriptAndComposeScenes(plan, composeScenes, {
    preferComposeOrder: composeScenes.length > 0,
  }).plan;
}

function normalizeScriptText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Map a saved compose Scene into a Script-tab row. */
export function partScriptSceneFromComposeScene(
  scene: {
    id?: string;
    subtitle?: string | null;
    narrationText?: string | null;
    kind?: string | null;
    audioUrl?: string | null;
    durationMs?: number | null;
    mediaUrl?: string | null;
    backgroundUrl?: string | null;
    compositeThumbUrl?: string | null;
    elements?: Array<{ mediaUrl?: string | null }> | null;
    recordingVoiceReplace?: boolean | null;
    recordingUseEmbeddedAudio?: boolean | null;
  },
  index: number,
): PartScriptScene {
  const subtitle = (scene.subtitle ?? "").trim();
  const narr = (scene.narrationText ?? "").trim();
  let type: PartScriptSceneType = "image";
  if (subtitle === "Intro") type = "intro";
  else if (subtitle === "Outro") type = "outro";
  else if (scene.kind === "question") type = "question";
  else if (scene.kind === "code") type = "coding";
  else if (scene.kind === "template") type = "template";
  else if (scene.kind === "recording") {
    type = scene.recordingUseEmbeddedAudio && !scene.recordingVoiceReplace
      ? "clip"
      : "recording2";
  }

  const imageFromCompose =
    (scene.compositeThumbUrl ?? "").trim() ||
    (scene.backgroundUrl ?? "").trim() ||
    (scene.elements?.[0]?.mediaUrl ?? "").trim() ||
    null;

  return {
    id: scene.id?.startsWith("scene-")
      ? `script_${scene.id}`
      : newPartScriptSceneId(),
    name: subtitle || `Scene ${index + 1}`,
    type,
    script: narr,
    audioUrl: scene.audioUrl ?? null,
    durationMs: scene.durationMs && scene.durationMs > 0 ? scene.durationMs : 0,
    ...(type === "image" && imageFromCompose ? { imageUrl: imageFromCompose } : {}),
    ...((type === "recording2" || type === "clip") && scene.mediaUrl
      ? { mediaUrl: scene.mediaUrl }
      : {}),
  };
}

/**
 * Build Script-tab rows aligned with stitch/compose scenes (strict 1:1).
 * Compose order wins when compose scenes exist. Planning-only orphans are
 * NOT kept here — use `alignScriptAndComposeScenes` to materialize stubs.
 */
export function syncScriptPlanWithComposeScenes(
  plan: PartScriptPlan | null | undefined,
  composeScenes: unknown,
): PartScriptPlan {
  // Empty stitch list must clear Script too — otherwise refresh rematerializes
  // stubs from leftover scriptScenes and "deleted" scenes come back.
  if (!Array.isArray(composeScenes) || composeScenes.length === 0) {
    return { scenes: [] };
  }

  const prev = plan?.scenes ?? [];
  const byScriptId = new Map(prev.map((s) => [s.id, s]));
  const byComposeId = new Map<string, PartScriptScene>();
  for (const s of prev) {
    const composeId = composeIdFromScriptSceneId(s.id);
    if (composeId) byComposeId.set(composeId, s);
  }
  const byNarration = new Map<string, PartScriptScene>();
  for (const s of prev) {
    const key = normalizeScriptText(s.script);
    if (key && !byNarration.has(key)) byNarration.set(key, s);
  }

  const scenes: PartScriptScene[] = [];
  for (let i = 0; i < composeScenes.length; i++) {
    const raw = composeScenes[i];
    if (!raw || typeof raw !== "object") continue;
    const cs = raw as {
      id?: string;
      subtitle?: string | null;
      narrationText?: string | null;
      kind?: string | null;
      audioUrl?: string | null;
      durationMs?: number | null;
      mediaUrl?: string | null;
      backgroundUrl?: string | null;
      compositeThumbUrl?: string | null;
      elements?: Array<{ mediaUrl?: string | null }> | null;
      recordingVoiceReplace?: boolean | null;
      recordingUseEmbeddedAudio?: boolean | null;
    };
    const base = partScriptSceneFromComposeScene(cs, i);
    const narrKey = normalizeScriptText(cs.narrationText ?? "");
    const enrich =
      (cs.id ? byComposeId.get(cs.id) : undefined) ||
      byScriptId.get(base.id) ||
      (narrKey ? byNarration.get(narrKey) : undefined);

    if (!enrich) {
      scenes.push(base);
      continue;
    }

    const composeNarr = (cs.narrationText ?? "").trim();
    const composeName = (cs.subtitle ?? "").trim();
    const scriptText =
      base.type === "intro" || base.type === "outro"
        ? composeNarr
        : composeNarr || enrich.script || "";
    scenes.push({
      ...enrich,
      ...base,
      id: base.id,
      name: composeName || enrich.name || base.name,
      script: scriptText,
      audioUrl: base.audioUrl ?? enrich.audioUrl ?? null,
      durationMs: base.durationMs || enrich.durationMs || 0,
      questionSubtype: enrich.questionSubtype ?? base.questionSubtype,
      templateSubtype: enrich.templateSubtype ?? base.templateSubtype,
      questionPaste: enrich.questionPaste,
      question: enrich.question,
      code: enrich.code,
      codeTypingBeats: enrich.codeTypingBeats,
      imageUrl: base.imageUrl ?? enrich.imageUrl ?? null,
      mediaUrl: base.mediaUrl ?? enrich.mediaUrl,
    });
  }

  return { scenes };
}

/** @deprecated Use syncScriptPlanWithComposeScenes — kept as alias for call sites. */
export function mergeScriptPlanWithComposeScenes(
  plan: PartScriptPlan,
  composeScenes: unknown,
): PartScriptPlan {
  return syncScriptPlanWithComposeScenes(plan, composeScenes);
}

/**
 * Apply Script-tab order to compose/stitch scenes (strict 1:1).
 * Only linked rows are kept; unlinked compose leftovers are dropped.
 * Missing compose scenes for linked rows are not invented here —
 * use `alignScriptAndComposeScenes` for that.
 */
export function applyScriptPlanToComposeScenes<T extends { id?: string }>(
  composeScenes: T[],
  plan: PartScriptPlan,
): { scenes: T[]; changed: boolean; shrunk: boolean } {
  const byId = new Map(
    composeScenes
      .filter((s) => typeof s.id === "string" && s.id)
      .map((s) => [s.id as string, s]),
  );
  const ordered: T[] = [];
  for (const row of plan.scenes) {
    const composeId = composeIdFromScriptSceneId(row.id);
    if (!composeId) continue;
    const hit = byId.get(composeId);
    if (!hit) continue;
    ordered.push(hit);
    byId.delete(composeId);
  }
  const shrunk = ordered.length < composeScenes.length;
  const changed =
    shrunk ||
    ordered.length !== composeScenes.length ||
    ordered.some((s, i) => s.id !== composeScenes[i]?.id);
  return { scenes: ordered, changed, shrunk };
}

/**
 * Enforce strict 1:1 Script ↔ Stitch identity.
 *
 * By default the Script plan wins for membership, order, and type (so Remove /
 * type changes in Script actually update Stitch). Pass `preferComposeOrder`
 * when loading a part so existing stitch scenes can seed missing script rows.
 */
export function alignScriptAndComposeScenes(
  plan: PartScriptPlan,
  composeScenes: Scene[],
  opts?: { preferComposeOrder?: boolean },
): { plan: PartScriptPlan; scenes: Scene[]; changed: boolean } {
  let workingPlan = plan;

  if (opts?.preferComposeOrder && composeScenes.length > 0) {
    workingPlan = syncScriptPlanWithComposeScenes(plan, composeScenes);
    // Keep script-only rows that aren't linked to a compose scene yet.
    const linkedComposeIds = new Set(
      workingPlan.scenes
        .map((s) => composeIdFromScriptSceneId(s.id))
        .filter((id): id is string => !!id),
    );
    const extras: PartScriptScene[] = [];
    for (const s of plan.scenes) {
      if (isLinkedScriptSceneId(s.id)) {
        const cid = composeIdFromScriptSceneId(s.id)!;
        if (linkedComposeIds.has(cid)) continue;
        extras.push({ ...s, id: newPartScriptSceneId() });
        continue;
      }
      if (!workingPlan.scenes.some((w) => w.id === s.id)) {
        extras.push(s);
      }
    }
    if (extras.length) {
      workingPlan = { scenes: [...workingPlan.scenes, ...extras] };
    }
  }

  const byComposeId = new Map(
    composeScenes.filter((s) => s.id).map((s) => [s.id, s]),
  );
  const nextPlanScenes: PartScriptScene[] = [];
  const nextCompose: Scene[] = [];
  let changed = false;

  for (let i = 0; i < workingPlan.scenes.length; i++) {
    const row = workingPlan.scenes[i]!;
    let composeId = composeIdFromScriptSceneId(row.id);
    let scriptRow = row;

    if (!composeId) {
      composeId = newComposeSceneId();
      scriptRow = { ...row, id: scriptSceneIdForCompose(composeId) };
      changed = true;
    }

    const existing = byComposeId.get(composeId);
    if (existing) {
      nextCompose.push(existing);
      byComposeId.delete(composeId);
    } else {
      nextCompose.push(composeStubFromScriptScene(scriptRow, composeId, i + 1));
      changed = true;
    }
    nextPlanScenes.push(scriptRow);
  }

  if (byComposeId.size > 0) changed = true;

  const prevComposeIds = composeScenes.map((s) => s.id).join("|");
  const nextComposeIds = nextCompose.map((s) => s.id).join("|");
  if (prevComposeIds !== nextComposeIds) changed = true;

  const prevPlanIds = plan.scenes.map((s) => s.id).join("|");
  const nextPlanIds = nextPlanScenes.map((s) => s.id).join("|");
  if (prevPlanIds !== nextPlanIds) changed = true;

  // Script type/name drift vs previous plan also counts as changed.
  if (
    !changed &&
    plan.scenes.some((s, i) => {
      const n = nextPlanScenes[i];
      return !n || n.type !== s.type || n.name !== s.name;
    })
  ) {
    changed = true;
  }

  return {
    plan: { scenes: nextPlanScenes },
    scenes: nextCompose,
    changed,
  };
}

/** @deprecated Prefer applyScriptPlanToComposeScenes */
export function reorderComposeScenesToMatchScript(
  composeScenes: Array<{ id?: string }>,
  plan: PartScriptPlan,
): Array<{ id?: string }> | null {
  const { scenes, changed } = applyScriptPlanToComposeScenes(composeScenes, plan);
  return changed ? scenes : null;
}

export interface SceneCompletionProgress {
  percent: number;
  missing: string[];
  complete: boolean;
}

function pushStep(
  steps: { label: string; done: boolean }[],
  label: string,
  done: boolean,
) {
  steps.push({ label, done });
}

/**
 * Type-aware completion checklist for a Script ↔ Stitch pair.
 * Percent = doneSteps / totalSteps. Used by Script progress bars and Stitch gate.
 */
export function sceneCompletionProgress(
  scriptScene: PartScriptScene,
  composeScene: Scene | null | undefined,
): SceneCompletionProgress {
  const steps: { label: string; done: boolean }[] = [];
  const cs = composeScene ?? null;
  const audioOk = !!(cs?.audioUrl && cs.audioUrl.trim() && (cs.durationMs ?? 0) > 0);
  const type = scriptScene.type;

  if (type === "unset") {
    pushStep(steps, "Select a scene type", false);
  } else if (type === "intro" || type === "outro") {
    const bumperOk =
      !!cs &&
      isCommonIntroOutroMediaUrl(cs.mediaUrl) &&
      (cs.durationMs ?? 0) > 0 &&
      (!!cs.audioUrl?.trim() || !!cs.recordingUseEmbeddedAudio);
    pushStep(steps, "Brand bumper added", bumperOk);
  } else if (type === "image") {
    const imageOk = !!(
      cs?.backgroundUrl?.trim() ||
      cs?.compositeThumbUrl?.trim() ||
      (cs?.elements && cs.elements.length > 0)
    );
    const cropsOk = !!(cs?.elements && cs.elements.length > 0);
    pushStep(steps, "Image / composite", imageOk);
    pushStep(steps, "Crops & placements", cropsOk);
    pushStep(steps, "Narration audio", audioOk);
  } else if (type === "question") {
    const contentOk = !!(
      (cs?.questionText && cs.questionText.trim().length >= 3) ||
      (cs?.codingTitle && cs.codingTitle.trim().length >= 2) ||
      scriptScene.questionPaste?.trim() ||
      scriptScene.codingPaste?.trim()
    );
    const introOk = !!(cs?.questionIntroAudioUrl?.trim());
    const markOk = !!(cs?.questionMarkAudioUrl?.trim());
    pushStep(steps, "Question content", contentOk && !!(cs?.questionText || cs?.codingTitle));
    pushStep(steps, "Intro audio", introOk);
    pushStep(steps, "Mark / countdown audio", markOk);
    pushStep(steps, "Narration audio", audioOk);
  } else if (type === "template") {
    const isCodeTyping = scriptScene.templateSubtype === "codeTyping";
    const setupOk = isCodeTyping
      ? !!(
          cs?.codeTypingBeats?.some((b) => b.code.trim()) ||
          scriptScene.codeTypingBeats?.some((b) => b.code.trim())
        )
      : !!(
          (cs?.templateText && cs.templateText.trim()) ||
          scriptScene.templateText?.trim() ||
          cs?.templateFixedPreset
        );
    pushStep(steps, "Template setup", setupOk && cs?.kind === "template");
    pushStep(steps, "Audio / timing", audioOk);
  } else if (type === "coding") {
    const codeOk = !!(
      (cs?.code && cs.code.trim().length >= 3) ||
      (cs?.codeTypingBeats && cs.codeTypingBeats.some((b) => b.code.trim())) ||
      scriptScene.code?.trim()
    );
    pushStep(steps, "Code content", codeOk && cs?.kind === "code");
    pushStep(steps, "Narration audio", audioOk);
  } else if (type === "recording2" || type === "clip") {
    const mediaOk = !!(cs?.mediaUrl?.trim() && (cs.recordingSourceDurationMs ?? cs.durationMs ?? 0) > 0);
    pushStep(
      steps,
      type === "clip" ? "Video clip media" : "Screen recording media",
      mediaOk,
    );
    pushStep(steps, "Audio", audioOk || !!(cs?.recordingUseEmbeddedAudio && cs.audioUrl?.trim()));
  } else {
    pushStep(steps, "Scene media", !!(cs && (cs.durationMs ?? 0) > 0));
    pushStep(steps, "Audio", audioOk);
  }

  const done = steps.filter((s) => s.done).length;
  const total = Math.max(1, steps.length);
  const percent = Math.round((done / total) * 100);
  const missing = steps.filter((s) => !s.done).map((s) => s.label);
  return {
    percent,
    missing,
    complete: missing.length === 0 && percent === 100,
  };
}

export function partSceneCompletionList(
  plan: PartScriptPlan,
  composeScenes: Scene[],
): Array<{
  index: number;
  scriptScene: PartScriptScene;
  composeScene: Scene | null;
  progress: SceneCompletionProgress;
}> {
  const byId = new Map(composeScenes.map((s) => [s.id, s]));
  return plan.scenes.map((scriptScene, index) => {
    const composeId = composeIdFromScriptSceneId(scriptScene.id);
    const composeScene = composeId ? byId.get(composeId) ?? null : null;
    return {
      index,
      scriptScene,
      composeScene,
      progress: sceneCompletionProgress(scriptScene, composeScene),
    };
  });
}

export function partScenesAllComplete(
  plan: PartScriptPlan,
  composeScenes: Scene[],
): boolean {
  if (!plan.scenes.length) return false;
  return partSceneCompletionList(plan, composeScenes).every((row) => row.progress.complete);
}

/** Human-readable incomplete checklist for the Stitch gate. */
export function partIncompleteSceneSummaries(
  plan: PartScriptPlan,
  composeScenes: Scene[],
): string[] {
  return partSceneCompletionList(plan, composeScenes)
    .filter((row) => !row.progress.complete)
    .map((row) => {
      const name =
        row.scriptScene.name.trim() ||
        row.composeScene?.subtitle?.trim() ||
        `Scene ${row.index + 1}`;
      const missing =
        row.progress.missing.length > 0
          ? row.progress.missing.join(", ")
          : "not finished";
      return `Scene ${row.index + 1} (${name}) — missing ${missing}`;
    });
}

/** True when a stitch row is still a placeholder (not save-ready). */
export function isIncompleteComposeScene(
  scene: Scene,
  scriptScene?: PartScriptScene | null,
): boolean {
  if (scriptScene) {
    return !sceneCompletionProgress(scriptScene, scene).complete;
  }
  // Fallback without script context: no usable duration/audio (and not a bumper).
  if (isCommonIntroOutroMediaUrl(scene.mediaUrl) && (scene.durationMs ?? 0) > 0) {
    return false;
  }
  return !(scene.audioUrl?.trim() && (scene.durationMs ?? 0) > 0);
}

export interface PartScriptValidationResult {
  ok: boolean;
  errors: string[];
  durationMs: number;
}

/** Soft validation for freeform script plans (AI generator optional). */
export function validatePartScriptPlan(plan: PartScriptPlan): PartScriptValidationResult {
  const errors: string[] = [];
  if (!plan.scenes?.length) {
    return { ok: false, errors: ["Plan has no scenes."], durationMs: 0 };
  }
  const durationMs = estimatePartScriptDurationMs(plan);
  return { ok: errors.length === 0, errors, durationMs };
}

export function sortPartScriptPlanByPattern(plan: PartScriptPlan): PartScriptPlan {
  return plan;
}

export function spokenWordCount(plan: PartScriptPlan): number {
  return partScriptSpokenText(plan)
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function minSpokenWordsForDuration(): number {
  return Math.ceil((PART_SCRIPT_MIN_MS / 60_000) * PART_SCRIPT_WPM) + 20;
}

export function targetSpokenWords(): { min: number; target: number; max: number } {
  return {
    min: minSpokenWordsForDuration(),
    target: Math.round(10.5 * PART_SCRIPT_WPM),
    max: Math.floor((PART_SCRIPT_MAX_MS / 60_000) * PART_SCRIPT_WPM) - 20,
  };
}

export function planFromAiJson(raw: unknown): PartScriptPlan {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(obj.scenes) ? obj.scenes : Array.isArray(raw) ? raw : [];
  const scenes: PartScriptScene[] = [];
  for (let i = 0; i < list.length; i++) {
    const scene = normalizePartScriptScene({
      ...(list[i] as object),
      id: (list[i] as { id?: string })?.id || newPartScriptSceneId(),
      name: (list[i] as { name?: string })?.name || `Scene ${i + 1}`,
    });
    if (scene) scenes.push(scene);
  }
  return { scenes: scenes.length ? scenes : emptyPartScriptPlan().scenes };
}

export function planFromAiJsonSorted(raw: unknown): PartScriptPlan {
  return planFromAiJson(raw);
}

export function sceneNeedsNarration(scene: PartScriptScene): boolean {
  if (scene.type === "unset") return false;
  if (scene.type === "intro" || scene.type === "outro") return false;
  if (scene.type === "recording2" || scene.type === "clip") return false;
  if (scene.type === "template" && scene.templateSubtype === "codeTyping") return false;
  return true;
}

export function goToSceneLabel(scene: PartScriptScene): string {
  if (scene.type === "question" && scene.questionSubtype) {
    return PART_SCRIPT_QUESTION_SUBTYPE_LABELS[scene.questionSubtype];
  }
  if (scene.type === "template" && scene.templateSubtype) {
    return PART_SCRIPT_TEMPLATE_SUBTYPE_LABELS[scene.templateSubtype];
  }
  return PART_SCRIPT_TYPE_LABELS[scene.type];
}
