import type {
  ComposeCodeDraft,
  ComposeDraft,
  ComposeQuestionDraft,
  ComposeRecordingDraft,
  ComposeSourceMode,
  ComposeTemplateDraft,
} from "@/lib/compose-scene";
import type { ComposeBackgroundPreset } from "@/lib/compose-background";
import { DEFAULT_CODE_TYPING_CPS, LEGACY_CODE_TYPING_CPS } from "@/lib/code-scene-sfx";

/** In-progress compose work for the current browser tab (survives refresh). */
export interface ComposeWorkingDraft {
  sourceMode: ComposeSourceMode;
  draft: ComposeDraft;
  codeDraft: ComposeCodeDraft;
  questionDraft: ComposeQuestionDraft;
  templateDraft: ComposeTemplateDraft;
  recordingDraft: ComposeRecordingDraft;
  questionPaste: string;
  /** Part-level script plan from the Script compose tab. */
  partScriptPlan?: import("@/lib/part-script").PartScriptPlan;
  /** @deprecated use partScriptPlan */
  partScript?: string;
  openSteps: string[];
  partTitle: string;
  selectedPartId: string | null;
  editingSceneId: string | null;
  backgroundPreset: ComposeBackgroundPreset;
  useDirectImagePrompt: boolean;
  directImagePrompt: string;
  uploadDataUrl: string | null;
  lastImagePrompt: string | null;
  showPreview: boolean;
  updatedAt: number;
}

const PREFIX = "compose:working:";

function storageKey(projectId: string): string {
  return `${PREFIX}${projectId}`;
}

function isEphemeralUrl(url: string | null | undefined): boolean {
  return !!url && (url.startsWith("blob:") || url.startsWith("data:"));
}

/**
 * Drop dead blob: URLs after refresh; keep data:/api assets.
 * blob: never survives reload — clear so the UI doesn't look "half loaded".
 */
function scrubEphemeralBlobs(d: ComposeWorkingDraft): ComposeWorkingDraft {
  const scrub = (url: string | null | undefined): string | null => {
    if (!url) return null;
    if (url.startsWith("blob:")) return null;
    return url;
  };

  const recording = { ...d.recordingDraft };
  const mediaWasBlob = recording.mediaUrl?.startsWith("blob:");
  const audioWasBlob = recording.audioUrl?.startsWith("blob:");
  recording.mediaUrl = scrub(recording.mediaUrl);
  recording.audioUrl = scrub(recording.audioUrl);
  if (mediaWasBlob || audioWasBlob) {
    recording.ready = !!(recording.mediaUrl && recording.audioUrl);
  }

  const draft = { ...d.draft };
  draft.audioUrl = scrub(draft.audioUrl);
  draft.compositeUrl = scrub(draft.compositeUrl) ?? draft.compositeUrl;

  const codeDraft = { ...d.codeDraft };
  codeDraft.audioUrl = scrub(codeDraft.audioUrl);
  // Upgrade browser drafts saved with the former 28 cps default. Without this,
  // refresh restores the stale value even though new and database-loaded scenes
  // use the current default.
  if (
    codeDraft.typingSpeedCps == null ||
    codeDraft.typingSpeedCps === LEGACY_CODE_TYPING_CPS
  ) {
    codeDraft.typingSpeedCps = DEFAULT_CODE_TYPING_CPS;
  }

  const questionDraft = { ...d.questionDraft };
  questionDraft.audioUrl = scrub(questionDraft.audioUrl);
  questionDraft.markAudioUrl = scrub(questionDraft.markAudioUrl);
  questionDraft.introAudioUrl = scrub(questionDraft.introAudioUrl);
  if (typeof questionDraft.predictCode !== "string") questionDraft.predictCode = "";
  if (questionDraft.predictSelectMode !== "msq") questionDraft.predictSelectMode = "mcq";
  if (
    questionDraft.kind !== "mcq" &&
    questionDraft.kind !== "msq" &&
    questionDraft.kind !== "coding" &&
    questionDraft.kind !== "predictOutput"
  ) {
    questionDraft.kind = "mcq";
  }

  const templateDraft = { ...d.templateDraft };
  templateDraft.audioUrl = scrub(templateDraft.audioUrl);
  templateDraft.previewUrl = scrub(templateDraft.previewUrl);

  return {
    ...d,
    draft,
    codeDraft,
    questionDraft,
    templateDraft,
    recordingDraft: recording,
    uploadDataUrl: isEphemeralUrl(d.uploadDataUrl) && d.uploadDataUrl?.startsWith("blob:")
      ? null
      : d.uploadDataUrl,
  };
}

export function readComposeWorkingDraft(projectId: string | null | undefined): ComposeWorkingDraft | null {
  if (!projectId || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ComposeWorkingDraft;
    if (!parsed || typeof parsed !== "object" || !parsed.sourceMode) return null;
    return scrubEphemeralBlobs(parsed);
  } catch {
    return null;
  }
}

/** Replace every inline data: URL with null so the draft fits in storage. */
function stripInlineData<T>(value: T): T {
  if (typeof value === "string") {
    return (value.startsWith("data:") ? null : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(stripInlineData) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripInlineData(v);
    }
    return out as unknown as T;
  }
  return value;
}

export function writeComposeWorkingDraft(
  projectId: string | null | undefined,
  draft: Omit<ComposeWorkingDraft, "updatedAt">,
): void {
  if (!projectId || typeof sessionStorage === "undefined") return;
  const payload: ComposeWorkingDraft = { ...draft, updatedAt: Date.now() };
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify(payload));
  } catch (e) {
    // Quota: retry without any inline data: URLs (uploads, crops, previews).
    // Uploaded images are persisted as /api/assets URLs, so this keeps the
    // rest of the draft (script, steps, question, timings) recoverable.
    try {
      sessionStorage.setItem(storageKey(projectId), JSON.stringify(stripInlineData(payload)));
    } catch {
      console.warn("[compose-working-draft] sessionStorage full or blocked", e);
    }
  }
}


export function clearComposeWorkingDraft(projectId: string | null | undefined): void {
  if (!projectId || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(storageKey(projectId));
  } catch {
    /* ignore */
  }
}

export function composeWorkingDraftHasContent(d: ComposeWorkingDraft): boolean {
  if (d.editingSceneId) return true;
  if (d.draft.script.trim() || d.draft.audioUrl || d.draft.compositeUrl) return true;
  if (d.codeDraft.script.trim() || d.codeDraft.code.trim() || d.codeDraft.audioUrl) return true;
  if (d.questionDraft.script.trim() || d.questionDraft.audioUrl || d.questionPaste.trim()) {
    return true;
  }
  if (d.templateDraft.script.trim() || d.templateDraft.audioUrl || d.templateDraft.text.trim()) {
    return true;
  }
  if (d.recordingDraft.mediaUrl || d.recordingDraft.audioUrl || d.recordingDraft.script.trim()) {
    return true;
  }
  if (d.directImagePrompt.trim() || d.uploadDataUrl) return true;
  if ((d.partScript ?? "").trim()) return true;
  // Names alone (default empty plan) do NOT count — otherwise placeholders
  // block loading the real script saved on the part.
  if (
    d.partScriptPlan?.scenes.some(
      (s) =>
        !!(
          s.script?.trim() ||
          s.scriptAfter?.trim() ||
          s.code?.trim() ||
          s.screen?.trim() ||
          s.expectedOutput?.trim() ||
          s.imagePrompt?.trim() ||
          s.practiceBrief?.trim() ||
          s.placeholderNote?.trim() ||
          s.question?.question?.trim()
        ),
    )
  ) {
    return true;
  }
  return false;
}
