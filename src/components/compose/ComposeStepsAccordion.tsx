import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import { ComposeAudioUpload } from "@/components/compose/ComposeAudioUpload";
import { BasicAudioEditor } from "@/components/compose/BasicAudioEditor";
import { ComposeVideoUpload } from "@/components/compose/ComposeVideoUpload";
import { RecordingTimeline } from "@/components/compose/RecordingTimeline";

/** Separates "generate with TTS" from "upload your own" on each narration step. */
function NarrationUploadDivider() {
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium text-muted-foreground">or upload narration</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
import {
  CheckCircle2,
  Film,
  ImageIcon,
  Loader2,
  Mic,
  Save,
  Sparkles,
  Layers,
  Trash2,
  XCircle,
  Pencil,
  Code2,
  Wand2,
  Plus,
} from "lucide-react";
import {
  partScriptPlanHasContent,
  type PartScriptPlan,
} from "@/lib/part-script";
import { PartScriptPanel } from "@/components/compose/PartScriptPanel";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { VideoPlayer } from "@/components/VideoPlayer";
import { CropCanvas } from "@/components/compose/CropCanvas";
import { AudioTimeline } from "@/components/compose/AudioTimeline";
import { ComposeImageUpload } from "@/components/compose/ComposeImageUpload";
import {
  type ComposeCodeDraft,
  type ComposeCrop,
  type ComposeDraft,
  type ComposeQuestionDraft,
  type ComposeRecordingDraft,
  type ComposeSourceMode,
  type ComposeTemplateDraft,
  type TemplateKind,
  type FixedTemplatePresetId,
} from "@/lib/compose-scene";
import { renderTemplatePreviewDataUrl, templateCountdownDurationMs } from "@/lib/template-scene-canvas";
import {
  beatsToFullCode,
  DEFAULT_CODE_TYPING_CPS,
  DEFAULT_CODE_OUTPUT_HOLD_MS,
  DEFAULT_CODE_RUN_DELAY_MS,
  emptyCodeTypingBeat,
  suggestedBeatsDurationMs,
  type CodeTypingBeat,
} from "@/lib/code-scene-sfx";
import {
  DEFAULT_CODE_TYPING_OUTPUT,
  DEFAULT_CODE_TYPING_OUTPUT_STEP2,
  DEFAULT_CODE_TYPING_SNIPPET,
  DEFAULT_CODE_TYPING_SNIPPET_STEP2,
  formatPythonCode,
} from "@/lib/format-python";
import {
  FIXED_TEMPLATE_FONT_SIZE,
  FIXED_TEMPLATE_PRESET_LIST,
  FIXED_TEMPLATE_TEXT_COLOR,
  getFixedTemplatePreset,
} from "@/lib/template-fixed-presets";
import { EXCALIFONT_STACK } from "@/lib/scene-font";
import type { SceneBackground } from "@/lib/scene-background";
import { ComposeBackgroundPicker } from "@/components/compose/ComposeBackgroundPicker";
import type { ComposeBackgroundPreset } from "@/lib/compose-background";
import { QUESTION_KIND_LABELS, type QuestionKind } from "@/lib/compose-question";
import {
  CODING_PROBLEM_TEMPLATE,
  parseCodingProblemText,
} from "@/lib/parse-coding-problem";
import { emptyCodingTestCases } from "@/lib/question-scene-layout";
import type { Scene } from "@/components/VideoPlayer";

function StepStatus({ done }: { done: boolean }) {
  return done ? (
    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-label="Done" />
  ) : (
    <XCircle className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-label="Not done" />
  );
}

function StepTrigger({
  done,
  icon: Icon,
  label,
}: {
  done: boolean;
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
}) {
  return (
    <div className="flex flex-1 items-center gap-2.5 pr-2">
      <StepStatus done={done} />
      <Icon size={15} className="shrink-0 text-muted-foreground" />
      <span>{label}</span>
    </div>
  );
}

export interface ImageStepStatus {
  image: boolean;
  tts: boolean;
  crop: boolean;
  timeline: boolean;
  preview: boolean;
  saveReady: boolean;
}

export interface CodeStepStatus {
  setup: boolean;
  tts: boolean;
  preview: boolean;
  saveReady: boolean;
  /** Question/coding: content fields ready (enables narration TTS). */
  contentOk?: boolean;
  introAudioOk?: boolean;
  markAudioOk?: boolean;
}

interface ComposeStepsAccordionProps {
  sourceMode: ComposeSourceMode;
  openSteps: string[];
  onOpenSteps: (steps: string[]) => void;
  draft: ComposeDraft;
  codeDraft: ComposeCodeDraft;
  questionDraft: ComposeQuestionDraft;
  templateDraft: ComposeTemplateDraft;
  recordingDraft: ComposeRecordingDraft;
  uploadDataUrl: string | null;
  onUploadChange: (url: string | null) => void;
  /** Part-level structured script (Script tab). */
  partScriptPlan: PartScriptPlan;
  onPartScriptPlanChange: (plan: PartScriptPlan) => void;
  /** Per-scene completion from Script ↔ Stitch alignment. */
  scriptSceneCompletions?: ReturnType<
    typeof import("@/lib/part-script").partSceneCompletionList
  >;
  savingPartScript?: boolean;
  partScriptSaveStatus?: "idle" | "pending" | "saving" | "saved" | "error";
  projectId?: string | null;
  selectedPartId?: string | null;
  onGoToScriptScene?: (scene: import("@/lib/part-script").PartScriptScene) => void;
  useDirectImagePrompt: boolean;
  onUseDirectImagePrompt: (v: boolean) => void;
  directImagePrompt: string;
  onDirectImagePrompt: (v: string) => void;
  lastImagePrompt: string | null;
  generatingImage: boolean;
  segmentingLayers?: boolean;
  generatingTts: boolean;
  saving: boolean;
  showPreview: boolean;
  canSaveScene: boolean;
  sceneSaveStatus?: "idle" | "pending" | "saving" | "saved" | "error";
  selectedCropId: string | null;
  onSelectCrop: (id: string | null) => void;
  previewScene: Scene | null;
  imageStatus: ImageStepStatus;
  codeStatus: CodeStepStatus;
  questionStatus: CodeStepStatus;
  templateStatus: CodeStepStatus;
  recordingStatus: CodeStepStatus;
  onDraftScript: (script: string) => void;
  onCodeDraft: (fn: (d: ComposeCodeDraft) => ComposeCodeDraft) => void;
  onQuestionDraft: (fn: (d: ComposeQuestionDraft) => ComposeQuestionDraft) => void;
  onTemplateDraft: (fn: (d: ComposeTemplateDraft) => ComposeTemplateDraft) => void;
  onRecordingDraft: (fn: (d: ComposeRecordingDraft) => ComposeRecordingDraft) => void;
  onGenerateImage: () => void;
  onGenerateTts: () => void;
  onCodeTts: () => void;
  onQuestionTts: () => void;
  onTemplateTts: () => void;
  onRecordingTts: () => void;
  /** Clip mode: demuxing audio from the uploaded video. */
  extractingClipAudio?: boolean;
  onClipVideoUploaded?: (result: { url: string; durationMs: number }) => void;
  /** Screen recording 2: auto STT + filler clean + Liam TTS + restitch. */
  processingRecording2?: boolean;
  /** Which transcript chunk is currently generating Liam audio (Screen recording 2). */
  recording2PhraseBusyIndex?: number | null;
  onRecording2VideoUploaded?: (result: { url: string; durationMs: number }) => void;
  /** Regenerate Liam voice from edited narration text (keeps video). */
  onRecording2RegenerateVoice?: () => void;
  onRecording2GeneratePhrase?: (phraseIndex: number) => void;
  onRecording2GenerateAll?: () => void;
  onRecording2AssembleVoice?: () => void;
  recording2Voice?: "am_michael" | "af_heart";
  onRecording2Voice?: (voice: "am_michael" | "af_heart") => void;
  /** Build silent audio for narration-free code typing templates. */
  onPrepareCodeTypingSilent?: () => void;
  preparingCodeTyping?: boolean;
  loadingFixedPresetId?: FixedTemplatePresetId | null;
  onAddFixedTemplate?: (id: FixedTemplatePresetId) => void;
  onUploadNarration: (dataUrl: string | null) => void;
  onCodeUploadNarration: (dataUrl: string | null) => void;
  onQuestionUploadNarration: (dataUrl: string | null) => void;
  onTemplateUploadNarration: (dataUrl: string | null) => void;
  onRecordingUploadNarration: (dataUrl: string | null) => void;
  questionPaste: string;
  onQuestionPaste: (text: string) => void;
  parsingQuestion: boolean;
  onParseQuestion: () => void;
  generatingMarkTts: boolean;
  onGenerateMarkTts: () => void;
  onUseDefaultMarkTts: () => void;
  generatingIntroTts: boolean;
  onGenerateIntroTts: () => void;
  onUseDefaultIntroTts: () => void;
  onAddCrop: (crop: ComposeCrop) => void;
  onRemoveCrop: (id: string) => void;
  /** Open draw/annotate modal for a cropped element. */
  onAnnotateCrop: (id: string) => void;
  onAddPlacement: (cropId: string, startMs: number, sfxUrl?: string | null) => void;
  onUpdatePlacement: (id: string, patch: { startMs?: number; sfxUrl?: string | null }) => void;
  onRemovePlacement: (id: string) => void;
  onDuration: (ms: number) => void;
  onPreview: () => void;
  onSave: () => void;
  onQuestionKind: (kind: QuestionKind) => void;
  backgroundPreset: ComposeBackgroundPreset;
  onBackgroundPreset: (preset: ComposeBackgroundPreset) => void;
  sceneBackground: SceneBackground;
  editingScene?: boolean;
}

export function ComposeStepsAccordion({
  sourceMode,
  openSteps,
  onOpenSteps,
  draft,
  codeDraft,
  questionDraft,
  templateDraft,
  recordingDraft,
  uploadDataUrl,
  onUploadChange,
  partScriptPlan,
  onPartScriptPlanChange,
  scriptSceneCompletions = [],
  savingPartScript = false,
  partScriptSaveStatus = "idle",
  projectId = null,
  selectedPartId = null,
  onGoToScriptScene,
  useDirectImagePrompt,
  onUseDirectImagePrompt,
  directImagePrompt,
  onDirectImagePrompt,
  lastImagePrompt,
  generatingImage,
  segmentingLayers = false,
  generatingTts,
  saving,
  showPreview,
  canSaveScene,
  sceneSaveStatus = "idle",
  selectedCropId,
  onSelectCrop,
  previewScene,
  imageStatus,
  codeStatus,
  questionStatus,
  templateStatus,
  recordingStatus,
  onDraftScript,
  onCodeDraft,
  onQuestionDraft,
  onTemplateDraft,
  onRecordingDraft,
  onGenerateImage,
  onGenerateTts,
  onCodeTts,
  onQuestionTts,
  onTemplateTts,
  onRecordingTts,
  extractingClipAudio = false,
  onClipVideoUploaded,
  processingRecording2 = false,
  recording2PhraseBusyIndex = null,
  onRecording2VideoUploaded,
  onRecording2RegenerateVoice,
  onRecording2GeneratePhrase,
  onRecording2GenerateAll,
  onRecording2AssembleVoice,
  recording2Voice = "am_michael",
  onRecording2Voice,
  onPrepareCodeTypingSilent,
  preparingCodeTyping = false,
  loadingFixedPresetId = null,
  onAddFixedTemplate,
  onUploadNarration,
  onCodeUploadNarration,
  onQuestionUploadNarration,
  onTemplateUploadNarration,
  onRecordingUploadNarration,
  questionPaste,
  onQuestionPaste,
  parsingQuestion,
  onParseQuestion,
  generatingMarkTts,
  onGenerateMarkTts,
  onUseDefaultMarkTts,
  generatingIntroTts,
  onGenerateIntroTts,
  onUseDefaultIntroTts,
  onAddCrop,
  onRemoveCrop,
  onAnnotateCrop,
  onAddPlacement,
  onUpdatePlacement,
  onRemovePlacement,
  onDuration,
  onPreview,
  onSave,
  onQuestionKind,
  backgroundPreset,
  onBackgroundPreset,
  sceneBackground,
  editingScene = false,
}: ComposeStepsAccordionProps) {
  const previewBackground = sceneBackground;
  const saveSceneLabel = editingScene
    ? "Update scene in part"
    : "Save scene to part";
  const sceneSaveButtonLabel =
    saving || sceneSaveStatus === "saving"
      ? "Saving…"
      : sceneSaveStatus === "pending"
        ? "Saving soon…"
        : sceneSaveStatus === "saved"
          ? "Saved"
          : sceneSaveStatus === "error"
            ? "Save failed — retry"
            : saveSceneLabel;
  const [templateCardPreviews, setTemplateCardPreviews] = useState<{
    text?: string;
    typing?: string;
    countdown?: string;
  }>({});
  const [fixedCardPreviews, setFixedCardPreviews] = useState<
    Partial<Record<FixedTemplatePresetId, string>>
  >({});

  useEffect(() => {
    if (sourceMode !== "template") return;
    let cancelled = false;
    void (async () => {
      const [text, typing, countdown, ...fixedEntries] = await Promise.all([
        renderTemplatePreviewDataUrl({
          type: "text",
          text: "Your headline here",
          color: "#1a1a1a",
          fontSize: 72,
        }),
        renderTemplatePreviewDataUrl({
          type: "typing",
          text: "Your headline here",
          color: "#1a1a1a",
          fontSize: 72,
          progress: 0.55,
        }),
        renderTemplatePreviewDataUrl({
          type: "countdown",
          text: "Get ready",
          color: "#1a1a1a",
          fontSize: 160,
          countdownSec: 5,
          progress: 0.4,
        }),
        ...FIXED_TEMPLATE_PRESET_LIST.map((preset) =>
          renderTemplatePreviewDataUrl({
            type: "text",
            text: preset.text,
            color: FIXED_TEMPLATE_TEXT_COLOR,
            fontSize: FIXED_TEMPLATE_FONT_SIZE,
          }).then((url) => [preset.id, url] as const),
        ),
      ]);
      if (!cancelled) {
        setTemplateCardPreviews({ text, typing, countdown });
        setFixedCardPreviews(Object.fromEntries(fixedEntries));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceMode]);

  useEffect(() => {
    if (sourceMode !== "template" || !templateDraft.picked) return;
    if (templateDraft.templateKind === "codeTyping") return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void renderTemplatePreviewDataUrl({
        type: templateDraft.templateKind === "codeTyping" ? "text" : templateDraft.templateKind,
        text: templateDraft.text,
        color: templateDraft.textColor,
        fontSize: templateDraft.fontSize,
        countdownSec: templateDraft.countdownSec,
        progress:
          templateDraft.templateKind === "countdown"
            ? 0.4
            : templateDraft.templateKind === "typing"
              ? 0.55
              : 0,
      }).then((url) => {
        if (cancelled) return;
        onTemplateDraft((d) => (d.previewUrl === url ? d : { ...d, previewUrl: url }));
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on visual fields only
  }, [
    sourceMode,
    templateDraft.picked,
    templateDraft.templateKind,
    templateDraft.text,
    templateDraft.textColor,
    templateDraft.fontSize,
    templateDraft.countdownSec,
  ]);

  function pickTemplate(kind: TemplateKind) {
    onTemplateDraft((d) => ({
      ...d,
      picked: true,
      mode: "editable",
      fixedPresetId: null,
      templateKind: kind,
      fontSize: kind === "countdown" ? 160 : 72,
      text: kind === "countdown" ? "Get ready" : "Your headline here",
      ready: false,
      previewUrl: null,
    }));
    if (kind === "codeTyping") {
      const cps = DEFAULT_CODE_TYPING_CPS;
      const beats: CodeTypingBeat[] = [
        emptyCodeTypingBeat({
          code: DEFAULT_CODE_TYPING_SNIPPET,
          output: DEFAULT_CODE_TYPING_OUTPUT,
          runDelayMs: DEFAULT_CODE_RUN_DELAY_MS,
          outputHoldMs: DEFAULT_CODE_OUTPUT_HOLD_MS,
        }),
        emptyCodeTypingBeat({
          code: DEFAULT_CODE_TYPING_SNIPPET_STEP2,
          output: DEFAULT_CODE_TYPING_OUTPUT_STEP2,
          runDelayMs: DEFAULT_CODE_RUN_DELAY_MS,
          outputHoldMs: 2000,
        }),
      ];
      onCodeDraft(() => ({
        script: "",
        code: beatsToFullCode(beats),
        codeLanguage: "py",
        codeVariant: "typing",
        title: "hello.py",
        audioUrl: null,
        durationMs: suggestedBeatsDurationMs(beats, cps),
        ready: false,
        silentNarration: true,
        typingSpeedCps: cps,
        codeOutput: beats[0]!.output,
        codeRunDelayMs: beats[0]!.runDelayMs,
        codeOutputHoldMs: beats[0]!.outputHoldMs,
        codeTypingBeats: beats,
      }));
      onBackgroundPreset("video-loop");
    }
  }

  const isFixedTemplate = templateDraft.mode === "fixed" && templateDraft.picked;
  const fixedPresetLabel =
    templateDraft.fixedPresetId != null
      ? getFixedTemplatePreset(templateDraft.fixedPresetId).label
      : null;

  if (sourceMode === "script") {
    return (
      <div className="rounded-lg border bg-card px-4 py-3">
        <PartScriptPanel
          plan={partScriptPlan}
          onChange={onPartScriptPlanChange}
          sceneCompletions={scriptSceneCompletions}
          canSave={canSaveScene}
          saving={savingPartScript}
          saveStatus={partScriptSaveStatus}
          projectId={projectId}
          selectedPartId={selectedPartId}
          onGoToScene={onGoToScriptScene}
        />
      </div>
    );
  }

  if (sourceMode === "template") {
    const setupOk = templateStatus.setup;
    return (
      <Accordion
        type="multiple"
        value={openSteps}
        onValueChange={onOpenSteps}
        className="rounded-lg border bg-card px-4"
      >
        <AccordionItem value="setup">
          <AccordionTrigger>
            <StepTrigger done={setupOk} icon={Sparkles} label="1. Pick a template" />
          </AccordionTrigger>
          <AccordionContent className="space-y-4">
            {!templateDraft.picked ? (
              <>
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium">Fixed templates</p>
                    <p className="text-xs text-muted-foreground">
                      Built-in text and narration — add directly to your part. Video loop background,
                      font size 100.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {FIXED_TEMPLATE_PRESET_LIST.map((preset) => {
                      const loading = loadingFixedPresetId === preset.id;
                      return (
                        <div
                          key={preset.id}
                          className="overflow-hidden rounded-xl border bg-background"
                        >
                          <div className="aspect-video w-full overflow-hidden bg-white">
                            {fixedCardPreviews[preset.id] ? (
                              <img
                                src={fixedCardPreviews[preset.id]}
                                alt=""
                                className="h-full w-full object-contain"
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                                Loading preview…
                              </div>
                            )}
                          </div>
                          <div className="space-y-2 border-t px-3 py-2.5">
                            <div>
                              <p className="font-medium">{preset.label}</p>
                              <p className="text-xs text-muted-foreground">{preset.desc}</p>
                            </div>
                            <button
                              type="button"
                              disabled={loading || !canSaveScene || !onAddFixedTemplate}
                              onClick={() => onAddFixedTemplate?.(preset.id)}
                              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                            >
                              {loading ? (
                                <>
                                  <Loader2 size={14} className="animate-spin" /> Adding…
                                </>
                              ) : (
                                <>
                                  <Save size={14} /> Add scene
                                </>
                              )}
                            </button>
                            {!canSaveScene && (
                              <p className="text-xs text-muted-foreground">
                                Create a project and name your part first.
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-3 border-t pt-4">
                  <div>
                    <p className="text-sm font-medium">Editable templates</p>
                    <p className="text-xs text-muted-foreground">
                      Customize before saving. Code typing uses monospace + BGM only (no narration).
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {(
                      [
                        {
                          id: "text" as const,
                          label: "Text card",
                          desc: "Headline or short message",
                          preview: templateCardPreviews.text,
                        },
                        {
                          id: "typing" as const,
                          label: "Typing text",
                          desc: "Text appears as if typing",
                          preview: templateCardPreviews.typing,
                        },
                        {
                          id: "codeTyping" as const,
                          label: "Code typing",
                          desc: "Python typing · no narration · BGM only",
                          preview: undefined as string | undefined,
                        },
                        {
                          id: "countdown" as const,
                          label: "Countdown",
                          desc: "Label + ticking seconds",
                          preview: templateCardPreviews.countdown,
                        },
                      ] as const
                    ).map((card) => (
                      <button
                        key={card.id}
                        type="button"
                        onClick={() => pickTemplate(card.id)}
                        className="group overflow-hidden rounded-xl border bg-background text-left transition hover:border-primary hover:shadow-md"
                      >
                        <div className="aspect-video w-full overflow-hidden bg-white">
                          {card.id === "codeTyping" ? (
                            <div className="flex h-full flex-col justify-center gap-1 bg-slate-50 px-4 font-mono text-[10px] leading-relaxed text-slate-700">
                              <span className="text-slate-400">1</span>
                              <span>
                                <span className="text-purple-600">def</span> greet():
                              </span>
                              <span className="pl-3 text-emerald-600">print(&quot;hi&quot;)</span>
                              <span className="inline-block h-3 w-1 animate-pulse bg-slate-700" />
                            </div>
                          ) : card.preview ? (
                            <img
                              src={card.preview}
                              alt=""
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                              Loading preview…
                            </div>
                          )}
                        </div>
                        <div className="border-t px-3 py-2.5">
                          <p className="font-medium">{card.label}</p>
                          <p className="text-xs text-muted-foreground">{card.desc}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : isFixedTemplate ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{fixedPresetLabel ?? "Fixed template"}</p>
                  <button
                    type="button"
                    onClick={() =>
                      onTemplateDraft((d) => ({
                        ...d,
                        picked: false,
                        mode: "editable",
                        fixedPresetId: null,
                        ready: false,
                        previewUrl: null,
                      }))
                    }
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Back to templates
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Locked template — text, voice, font size (100), and video loop background cannot be
                  changed.
                </p>
                <div
                  className="rounded-lg border bg-white px-4 py-6 text-center"
                  style={{
                    fontFamily: EXCALIFONT_STACK,
                    fontSize: 28,
                    color: templateDraft.textColor,
                  }}
                >
                  {templateDraft.text}
                </div>
                {templateDraft.previewUrl && (
                  <div className="overflow-hidden rounded-lg border bg-white">
                    <img
                      src={templateDraft.previewUrl}
                      alt="Template preview"
                      className="aspect-video w-full object-contain"
                    />
                  </div>
                )}
              </>
            ) : templateDraft.templateKind === "codeTyping" ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="inline-flex items-center gap-1.5 text-sm font-medium">
                    <Code2 size={14} /> Code typing
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      onTemplateDraft((d) => ({
                        ...d,
                        picked: false,
                        mode: "editable",
                        fixedPresetId: null,
                        ready: false,
                        previewUrl: null,
                      }))
                    }
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Change template
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Light-theme code window · monospace · no narration (BGM only). Add steps: type
                  code → Run → show output for N seconds → continue typing from where you left off.
                </p>
                <label className="block text-sm font-medium">
                  Window title
                  <input
                    value={codeDraft.title}
                    onChange={(e) =>
                      onCodeDraft((d) => ({ ...d, title: e.target.value, ready: false }))
                    }
                    className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm"
                    placeholder="hello.py"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">Language</span>
                  <span className="rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
                    Python
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onCodeDraft((d) => {
                        const beats = (d.codeTypingBeats ?? []).map((b) => ({
                          ...b,
                          code: formatPythonCode(b.code),
                        }));
                        return {
                          ...d,
                          codeTypingBeats: beats,
                          code: beatsToFullCode(beats),
                          codeLanguage: "py",
                          ready: false,
                        };
                      })
                    }
                    className="ml-auto inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                  >
                    <Wand2 size={12} /> Format Python
                  </button>
                </div>

                <div className="space-y-3">
                  {(codeDraft.codeTypingBeats ?? []).map((beat, index) => (
                    <div
                      key={beat.id}
                      className="space-y-2 rounded-lg border bg-muted/20 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          Step {index + 1}
                          {index > 0 ? (
                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                              (continues from previous)
                            </span>
                          ) : null}
                        </p>
                        {(codeDraft.codeTypingBeats?.length ?? 0) > 1 ? (
                          <button
                            type="button"
                            onClick={() =>
                              onCodeDraft((d) => {
                                const next = (d.codeTypingBeats ?? []).filter(
                                  (b) => b.id !== beat.id,
                                );
                                return {
                                  ...d,
                                  codeTypingBeats: next,
                                  code: beatsToFullCode(next),
                                  codeOutput: next[0]?.output ?? "",
                                  codeRunDelayMs: next[0]?.runDelayMs,
                                  codeOutputHoldMs: next[0]?.outputHoldMs,
                                  ready: false,
                                };
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 size={12} /> Remove
                          </button>
                        ) : null}
                      </div>
                      <label className="block text-xs font-medium text-muted-foreground">
                        Code typed in this step
                        <textarea
                          value={beat.code}
                          onChange={(e) => {
                            const value = e.target.value;
                            onCodeDraft((d) => {
                              const next = (d.codeTypingBeats ?? []).map((b) =>
                                b.id === beat.id ? { ...b, code: value } : b,
                              );
                              return {
                                ...d,
                                codeTypingBeats: next,
                                code: beatsToFullCode(next),
                                codeLanguage: "py",
                                codeVariant: "typing",
                                silentNarration: true,
                                ready: false,
                              };
                            });
                          }}
                          rows={index === 0 ? 10 : 5}
                          spellCheck={false}
                          className="mt-1 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs leading-relaxed text-slate-800"
                          placeholder={
                            index === 0
                              ? DEFAULT_CODE_TYPING_SNIPPET
                              : "# more code…"
                          }
                        />
                      </label>
                      <label className="block text-xs font-medium text-muted-foreground">
                        Output after Run
                        <textarea
                          value={beat.output}
                          onChange={(e) => {
                            const value = e.target.value;
                            onCodeDraft((d) => {
                              const next = (d.codeTypingBeats ?? []).map((b) =>
                                b.id === beat.id ? { ...b, output: value } : b,
                              );
                              return {
                                ...d,
                                codeTypingBeats: next,
                                codeOutput: next[0]?.output ?? value,
                                ready: false,
                              };
                            });
                          }}
                          rows={3}
                          spellCheck={false}
                          className="mt-1 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs leading-relaxed text-slate-800"
                          placeholder={DEFAULT_CODE_TYPING_OUTPUT}
                        />
                      </label>
                      <div className="flex flex-wrap gap-4">
                        <label className="text-xs font-medium text-muted-foreground">
                          Output shows for (sec)
                          <input
                            type="number"
                            min={0.5}
                            max={60}
                            step={0.5}
                            value={beat.outputHoldMs / 1000}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              const sec = Number.isFinite(v)
                                ? Math.max(0.5, Math.min(60, v))
                                : 2.5;
                              onCodeDraft((d) => {
                                const next = (d.codeTypingBeats ?? []).map((b) =>
                                  b.id === beat.id
                                    ? { ...b, outputHoldMs: Math.round(sec * 1000) }
                                    : b,
                                );
                                return {
                                  ...d,
                                  codeTypingBeats: next,
                                  codeOutputHoldMs: next[0]?.outputHoldMs,
                                  ready: false,
                                };
                              });
                            }}
                            className="mt-1 block w-24 rounded-md border bg-background px-2 py-1 text-sm tabular-nums"
                          />
                        </label>
                        <label className="text-xs font-medium text-muted-foreground">
                          Run delay (sec)
                          <input
                            type="number"
                            min={0}
                            max={10}
                            step={0.1}
                            value={beat.runDelayMs / 1000}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              const sec = Number.isFinite(v)
                                ? Math.max(0, Math.min(10, v))
                                : 0.7;
                              onCodeDraft((d) => {
                                const next = (d.codeTypingBeats ?? []).map((b) =>
                                  b.id === beat.id
                                    ? { ...b, runDelayMs: Math.round(sec * 1000) }
                                    : b,
                                );
                                return {
                                  ...d,
                                  codeTypingBeats: next,
                                  codeRunDelayMs: next[0]?.runDelayMs,
                                  ready: false,
                                };
                              });
                            }}
                            className="mt-1 block w-24 rounded-md border bg-background px-2 py-1 text-sm tabular-nums"
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      onCodeDraft((d) => {
                        const next = [
                          ...(d.codeTypingBeats ?? []),
                          emptyCodeTypingBeat({
                            code: "\n",
                            output: "",
                            runDelayMs: DEFAULT_CODE_RUN_DELAY_MS,
                            outputHoldMs: DEFAULT_CODE_OUTPUT_HOLD_MS,
                          }),
                        ];
                        return {
                          ...d,
                          codeTypingBeats: next,
                          code: beatsToFullCode(next),
                          ready: false,
                        };
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                  >
                    <Plus size={14} /> Add step (more code + output)
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {templateDraft.templateKind === "countdown"
                      ? "Countdown"
                      : templateDraft.templateKind === "typing"
                        ? "Typing text"
                        : "Text card"}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      onTemplateDraft((d) => ({
                        ...d,
                        picked: false,
                        mode: "editable",
                        fixedPresetId: null,
                        ready: false,
                        previewUrl: null,
                      }))
                    }
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Change template
                  </button>
                </div>

                <p className="text-xs text-muted-foreground">
                  White background · Excalifont. Customize text, color, and size, then add narration.
                  {templateDraft.templateKind === "typing"
                    ? " Text reveals character-by-character with the narration."
                    : null}
                </p>

                <label className="block text-sm font-medium">
                  {templateDraft.templateKind === "countdown" ? "Label (optional)" : "Text"}
                  <textarea
                    value={templateDraft.text}
                    onChange={(e) =>
                      onTemplateDraft((d) => ({ ...d, text: e.target.value, ready: false }))
                    }
                    rows={templateDraft.templateKind === "countdown" ? 2 : 4}
                    className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
                    style={{ fontFamily: EXCALIFONT_STACK }}
                    placeholder={
                      templateDraft.templateKind === "countdown"
                        ? "Get ready"
                        : "Your headline here"
                    }
                  />
                </label>

                <div className="flex flex-wrap gap-4">
                  <label className="text-sm font-medium">
                    Text color
                    <input
                      type="color"
                      value={templateDraft.textColor}
                      onChange={(e) =>
                        onTemplateDraft((d) => ({ ...d, textColor: e.target.value, ready: false }))
                      }
                      className="ml-2 h-8 w-12 cursor-pointer rounded border bg-background"
                    />
                  </label>
                  <label className="text-sm font-medium">
                    Font size
                    <input
                      type="number"
                      min={24}
                      max={280}
                      value={templateDraft.fontSize}
                      onChange={(e) =>
                        onTemplateDraft((d) => ({
                          ...d,
                          fontSize: Math.max(24, Math.min(280, Number(e.target.value) || 72)),
                          ready: false,
                        }))
                      }
                      className="ml-2 w-20 rounded-md border bg-background px-2 py-1 text-sm"
                    />
                  </label>
                  {templateDraft.templateKind === "countdown" && (
                    <label className="text-sm font-medium">
                      Seconds
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={templateDraft.countdownSec}
                    onChange={(e) => {
                      const sec = Math.max(1, Math.min(60, Number(e.target.value) || 5));
                      onTemplateDraft((d) => ({
                        ...d,
                        countdownSec: sec,
                        durationMs:
                          d.templateKind === "countdown"
                            ? templateCountdownDurationMs(sec)
                            : d.durationMs,
                        ready: false,
                      }));
                    }}
                        className="ml-2 w-16 rounded-md border bg-background px-2 py-1 text-sm"
                      />
                    </label>
                  )}
                </div>

                {templateDraft.previewUrl && (
                  <div className="overflow-hidden rounded-lg border bg-white">
                    <img
                      src={templateDraft.previewUrl}
                      alt="Template preview"
                      className="aspect-video w-full object-contain"
                    />
                  </div>
                )}
              </>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="tts">
          <AccordionTrigger>
            <StepTrigger
              done={templateStatus.tts}
              icon={templateDraft.templateKind === "codeTyping" ? Film : Mic}
              label={
                templateDraft.templateKind === "codeTyping"
                  ? "2. Timing & speed"
                  : "2. Narration (TTS)"
              }
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            {templateDraft.templateKind === "codeTyping" ? (
              <>
                <p className="text-xs text-muted-foreground">
                  No voiceover. Global typing speed applies to every step. Per-step Run delay and
                  output duration are set above. Part BGM plays under this scene.
                </p>
                <label className="block text-sm font-medium">
                  Typing speed (chars / sec)
                  <input
                    type="number"
                    min={8}
                    max={80}
                    step={1}
                    value={codeDraft.typingSpeedCps ?? DEFAULT_CODE_TYPING_CPS}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      onCodeDraft((d) => ({
                        ...d,
                        typingSpeedCps: Number.isFinite(v)
                          ? Math.max(8, Math.min(80, Math.round(v)))
                          : DEFAULT_CODE_TYPING_CPS,
                        ready: false,
                      }));
                    }}
                    className="mt-1 w-28 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Code font size (px)
                  <input
                    type="number"
                    min={10}
                    max={48}
                    step={1}
                    value={codeDraft.codeFontSize ?? 14}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      onCodeDraft((d) => ({
                        ...d,
                        codeFontSize: Number.isFinite(v)
                          ? Math.max(10, Math.min(48, Math.round(v)))
                          : 14,
                        ready: false,
                      }));
                    }}
                    className="mt-1 w-28 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Scene duration (sec)
                  <input
                    type="number"
                    min={2}
                    max={300}
                    step={0.5}
                    value={
                      codeDraft.durationMs > 0
                        ? codeDraft.durationMs / 1000
                        : suggestedBeatsDurationMs(
                            codeDraft.codeTypingBeats ?? [],
                            codeDraft.typingSpeedCps ?? DEFAULT_CODE_TYPING_CPS,
                          ) / 1000
                    }
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      const sec = Number.isFinite(v) ? Math.max(2, Math.min(300, v)) : 8;
                      onCodeDraft((d) => ({
                        ...d,
                        durationMs: Math.round(sec * 1000),
                        ready: false,
                      }));
                    }}
                    className="mt-1 w-28 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums"
                  />
                </label>
                <p className="text-[11px] text-muted-foreground">
                  {(codeDraft.codeTypingBeats ?? []).length} step
                  {(codeDraft.codeTypingBeats ?? []).length === 1 ? "" : "s"} · suggested total ~{" "}
                  {(
                    suggestedBeatsDurationMs(
                      codeDraft.codeTypingBeats ?? [],
                      codeDraft.typingSpeedCps ?? DEFAULT_CODE_TYPING_CPS,
                    ) / 1000
                  ).toFixed(1)}
                  s (typing + run delays + output holds).
                </p>
                <button
                  type="button"
                  disabled={
                    preparingCodeTyping ||
                    !(codeDraft.codeTypingBeats ?? []).some((b) => b.code.trim().length >= 1) ||
                    !(codeDraft.codeTypingBeats ?? []).some((b) => b.output.trim().length >= 1) ||
                    !onPrepareCodeTypingSilent
                  }
                  onClick={() => onPrepareCodeTypingSilent?.()}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {preparingCodeTyping ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Film size={16} />
                  )}
                  Apply timing
                </button>
                {codeDraft.ready && codeDraft.audioUrl && (
                  <p className="text-xs text-emerald-700">
                    Ready · {(codeDraft.durationMs / 1000).toFixed(1)}s silent track (BGM only)
                  </p>
                )}
              </>
            ) : isFixedTemplate ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Built-in narration — generated once and reused for every scene using this template.
                </p>
                {templateDraft.audioUrl && (
                  <audio controls src={templateDraft.audioUrl} className="w-full max-w-md" />
                )}
              </>
            ) : (
              <>
                <label className="text-sm font-medium">Narration script</label>
                <textarea
                  value={templateDraft.script}
                  onChange={(e) =>
                    onTemplateDraft((d) => ({ ...d, script: e.target.value, ready: false }))
                  }
                  rows={4}
                  placeholder="What should the voice say during this card…"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={generatingTts || templateDraft.script.trim().length < 3}
                  onClick={onTemplateTts}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {generatingTts ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
                  Generate TTS
                </button>
                {templateDraft.audioUrl && (
                  <audio controls src={templateDraft.audioUrl} className="w-full max-w-md" />
                )}
                <NarrationUploadDivider />
                <ComposeAudioUpload
                  value={templateDraft.audioUrl ?? null}
                  onChange={onTemplateUploadNarration}
                  disabled={generatingTts}
                />
              </>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="preview">
          <AccordionTrigger>
            <StepTrigger done={templateStatus.preview} icon={Film} label="3. Preview" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            {isFixedTemplate ? (
              <p className="text-xs text-muted-foreground">Video loop background (fixed)</p>
            ) : (
              <ComposeBackgroundPicker value={backgroundPreset} onChange={onBackgroundPreset} />
            )}
            <button
              type="button"
              disabled={!previewScene}
              onClick={onPreview}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <Film size={16} /> Preview scene
            </button>
            {showPreview && previewScene && (
              <VideoPlayer
                scenes={[previewScene]}
                background={previewBackground}
                projectId={projectId}
              />
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="save">
          <AccordionTrigger>
            <StepTrigger done={templateStatus.saveReady} icon={Save} label={`4. ${saveSceneLabel}`} />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            {!canSaveScene && (
              <p className="text-sm text-muted-foreground">
                Create a project and name your part at the top before saving scenes.
              </p>
            )}
            <button
              type="button"
              disabled={saving || !templateStatus.saveReady || !canSaveScene}
              onClick={onSave}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {sceneSaveButtonLabel}
            </button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  if (sourceMode === "question") {
    return (
      <Accordion
        type="multiple"
        value={openSteps}
        onValueChange={onOpenSteps}
        className="rounded-lg border bg-card px-4"
      >
        <AccordionItem value="setup">
          <AccordionTrigger>
            <StepTrigger
              done={questionStatus.setup}
              icon={Sparkles}
              label={`1. ${QUESTION_KIND_LABELS[questionDraft.kind]} setup`}
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {(["mcq", "msq", "coding", "predictOutput"] as QuestionKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => onQuestionKind(kind)}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    questionDraft.kind === kind
                      ? "border-primary bg-primary/10 font-medium"
                      : "hover:bg-accent"
                  }`}
                >
                  {QUESTION_KIND_LABELS[kind]}
                </button>
              ))}
            </div>

            {questionDraft.kind === "coding" ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Copy the template, replace with your problem, then click Fill fields. Needs title,
                  instruction, starter code, and 1–3 test cases (each with Input + Output).
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(CODING_PROBLEM_TEMPLATE);
                      } catch {
                        onQuestionDraft((d) => ({
                          ...d,
                          codingPaste: CODING_PROBLEM_TEMPLATE,
                          ready: false,
                        }));
                      }
                    }}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
                  >
                    Copy template
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onQuestionDraft((d) => ({
                        ...d,
                        codingPaste: CODING_PROBLEM_TEMPLATE,
                        ready: false,
                      }));
                    }}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
                  >
                    Insert template
                  </button>
                </div>
                <label className="text-sm font-medium">Paste problem (template format)</label>
                <textarea
                  value={questionDraft.codingPaste}
                  onChange={(e) =>
                    onQuestionDraft((d) => ({ ...d, codingPaste: e.target.value, ready: false }))
                  }
                  rows={14}
                  placeholder={CODING_PROBLEM_TEMPLATE}
                  className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                />
                  <button
                    type="button"
                    disabled={questionDraft.codingPaste.trim().length < 20}
                    onClick={() => {
                      const parsed = parseCodingProblemText(questionDraft.codingPaste);
                      if (!parsed) {
                        window.alert(
                          "Could not parse. Keep Title, Instruction, Starter Code, and at least one Test Case with Input + Output.",
                        );
                        return;
                      }
                      const tests = emptyCodingTestCases();
                      parsed.testCases.slice(0, 3).forEach((t, i) => {
                        tests[i] = {
                          label: t.label || `Case ${i + 1}`,
                          input: t.input,
                          output: t.output,
                        };
                      });
                      onQuestionDraft((d) => ({
                        ...d,
                        codingTitle: parsed.title,
                        subtitle: parsed.title,
                        question: parsed.instruction,
                        codingStarterCode: parsed.starterCode,
                        codingTestCases: tests,
                        ready: false,
                      }));
                    }}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                  >
                    <Sparkles size={16} />
                    Fill fields from template
                  </button>

                {(questionDraft.codingTitle ||
                  questionDraft.question ||
                  questionDraft.codingStarterCode) && (
                  <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs font-semibold text-muted-foreground">Filled fields</p>
                    <label className="text-sm">
                      <span className="font-medium">Title</span>
                      <input
                        value={questionDraft.codingTitle}
                        onChange={(e) =>
                          onQuestionDraft((d) => ({
                            ...d,
                            codingTitle: e.target.value,
                            subtitle: e.target.value || d.subtitle,
                            ready: false,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="text-sm">
                      <span className="font-medium">Instruction</span>
                      <textarea
                        value={questionDraft.question}
                        onChange={(e) =>
                          onQuestionDraft((d) => ({
                            ...d,
                            question: e.target.value,
                            ready: false,
                          }))
                        }
                        rows={4}
                        className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="text-sm">
                      <span className="font-medium">Starter code</span>
                      <textarea
                        value={questionDraft.codingStarterCode}
                        onChange={(e) =>
                          onQuestionDraft((d) => ({
                            ...d,
                            codingStarterCode: e.target.value,
                            ready: false,
                          }))
                        }
                        rows={6}
                        className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs"
                      />
                    </label>
                    <p className="text-sm font-medium">Test cases (1–3)</p>
                    {questionDraft.codingTestCases.map((tc, i) => (
                      <div key={i} className="space-y-2 rounded-lg border bg-background p-3">
                        <p className="text-xs font-medium text-muted-foreground">
                          {tc.label || `Case ${i + 1}`}
                        </p>
                        <input
                          value={tc.input}
                          onChange={(e) =>
                            onQuestionDraft((d) => {
                              const codingTestCases = [
                                ...d.codingTestCases,
                              ] as typeof d.codingTestCases;
                              codingTestCases[i] = {
                                ...codingTestCases[i],
                                input: e.target.value,
                              };
                              return { ...d, codingTestCases, ready: false };
                            })
                          }
                          placeholder="Input"
                          className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs"
                        />
                        <input
                          value={tc.output}
                          onChange={(e) =>
                            onQuestionDraft((d) => {
                              const codingTestCases = [
                                ...d.codingTestCases,
                              ] as typeof d.codingTestCases;
                              codingTestCases[i] = {
                                ...codingTestCases[i],
                                output: e.target.value,
                              };
                              return { ...d, codingTestCases, ready: false };
                            })
                          }
                          placeholder="Output"
                          className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : questionDraft.kind === "predictOutput" ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Question first, then a code block, then MCQ or MSQ options — what does the code
                  output?
                </p>
                <div className="flex flex-wrap gap-2">
                  {(["mcq", "msq"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() =>
                        onQuestionDraft((d) => ({
                          ...d,
                          predictSelectMode: mode,
                          ready: false,
                        }))
                      }
                      className={`rounded-md border px-3 py-1.5 text-sm ${
                        questionDraft.predictSelectMode === mode
                          ? "border-primary bg-primary/10 font-medium"
                          : "hover:bg-accent"
                      }`}
                    >
                      {mode === "mcq" ? "MCQ · pick one" : "MSQ · pick many"}
                    </button>
                  ))}
                </div>
                <label className="text-sm font-medium">Paste (optional)</label>
                <textarea
                  value={questionPaste}
                  onChange={(e) => onQuestionPaste(e.target.value)}
                  rows={8}
                  placeholder={`What is the output of this code?\n\n\`\`\`python\nx = [1, 2, 3]\nprint(x[-1])\n\`\`\`\n\nA) 1\nB) 2\nC) 3\nD) Error`}
                  className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                />
                <button
                  type="button"
                  disabled={parsingQuestion || questionPaste.trim().length < 10}
                  onClick={onParseQuestion}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {parsingQuestion ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  Fill fields from paste
                </button>
                <label className="text-sm font-medium">Question</label>
                <textarea
                  value={questionDraft.question}
                  onChange={(e) =>
                    onQuestionDraft((d) => ({ ...d, question: e.target.value, ready: false }))
                  }
                  rows={2}
                  placeholder="What is the output of this code?"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
                />
                <label className="text-sm font-medium">Code</label>
                <textarea
                  value={questionDraft.predictCode}
                  onChange={(e) =>
                    onQuestionDraft((d) => ({
                      ...d,
                      predictCode: e.target.value,
                      ready: false,
                    }))
                  }
                  rows={6}
                  spellCheck={false}
                  placeholder={"x = [1, 2, 3]\nprint(x[-1])"}
                  className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                />
                <label className="text-sm font-medium">Subtitle label</label>
                <input
                  value={questionDraft.subtitle}
                  onChange={(e) =>
                    onQuestionDraft((d) => ({ ...d, subtitle: e.target.value, ready: false }))
                  }
                  placeholder="Predict output"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  {(["A", "B", "C", "D"] as const).map((letter, i) => (
                    <label key={letter} className="text-sm">
                      <span className="font-medium">Option {letter}</span>
                      <input
                        value={questionDraft.options[i]}
                        onChange={(e) =>
                          onQuestionDraft((d) => {
                            const options = [...d.options] as [string, string, string, string];
                            options[i] = e.target.value;
                            return { ...d, options, ready: false };
                          })
                        }
                        className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
                        placeholder={letter === "C" ? "3" : `"${letter}"`}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Paste a question in any format — AI fills the fields below. Correct answer is
                  optional.
                </p>
                <label className="text-sm font-medium">Paste question (any format)</label>
                <textarea
                  value={questionPaste}
                  onChange={(e) => onQuestionPaste(e.target.value)}
                  rows={8}
                  placeholder={`Which of these is a Python Boolean value?\n\nA) "True"\nB) True\nC) "Boolean"\nD) 1.5`}
                  className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                />
                <button
                  type="button"
                  disabled={parsingQuestion || questionPaste.trim().length < 10}
                  onClick={onParseQuestion}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {parsingQuestion ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  Fill fields with AI
                </button>
                <label className="text-sm font-medium">Question</label>
                <textarea
                  value={questionDraft.question}
                  onChange={(e) =>
                    onQuestionDraft((d) => ({ ...d, question: e.target.value, ready: false }))
                  }
                  rows={3}
                  placeholder="Which of these is a Python Boolean value?"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
                />
                <label className="text-sm font-medium">Subtitle label</label>
                <input
                  value={questionDraft.subtitle}
                  onChange={(e) =>
                    onQuestionDraft((d) => ({ ...d, subtitle: e.target.value, ready: false }))
                  }
                  placeholder="Question"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  {(["A", "B", "C", "D"] as const).map((letter, i) => (
                    <label key={letter} className="text-sm">
                      <span className="font-medium">Option {letter}</span>
                      <input
                        value={questionDraft.options[i]}
                        onChange={(e) =>
                          onQuestionDraft((d) => {
                            const options = [...d.options] as [string, string, string, string];
                            options[i] = e.target.value;
                            return { ...d, options, ready: false };
                          })
                        }
                        className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
                        placeholder={letter === "B" ? "True" : `"${letter}"`}
                      />
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-semibold">Intro page</p>
              <p className="text-xs text-muted-foreground">
                {questionDraft.kind === "coding"
                  ? "Default voice says “Now let's try to solve a coding problem” (generated once and reused)."
                  : `Before the question: this screen with voiceover, then a ${questionDraft.introGapSec}s pause.`}
              </p>
              <label className="text-sm font-medium">Screen text</label>
              <input
                value={questionDraft.introText}
                onChange={(e) =>
                  onQuestionDraft((d) => ({
                    ...d,
                    introText: e.target.value,
                    ready: false,
                  }))
                }
                placeholder={
                  questionDraft.kind === "coding"
                    ? "Now let's try to solve a coding problem"
                    : "Now test your understanding"
                }
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
              />
              <label className="text-sm">
                <span className="font-medium">Gap before question (sec)</span>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={questionDraft.introGapSec}
                  onChange={(e) =>
                    onQuestionDraft((d) => ({
                      ...d,
                      introGapSec: Math.max(0, Number(e.target.value) || 0),
                      ready: false,
                    }))
                  }
                  className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={generatingIntroTts}
                  onClick={onUseDefaultIntroTts}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-60"
                >
                  Use default voice
                </button>
                <button
                  type="button"
                  disabled={generatingIntroTts || questionDraft.introText.trim().length < 2}
                  onClick={onGenerateIntroTts}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {generatingIntroTts ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Mic size={16} />
                  )}
                  Generate intro TTS
                </button>
              </div>
              {questionDraft.introAudioUrl && (
                <audio controls src={questionDraft.introAudioUrl} className="w-full max-w-md" />
              )}
              {questionDraft.introAudioUrl &&
                questionDraft.introAudioForText.trim() !== questionDraft.introText.trim() && (
                  <p className="text-xs text-amber-700">
                    Text changed — regenerate intro TTS to match.
                  </p>
                )}
            </div>

            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-semibold">Countdown page</p>
              <p className="text-xs text-muted-foreground">
                {questionDraft.kind === "coding"
                  ? "Default voice says “Coding screen coming up in 3, 2, 1” (generated once and reused)."
                  : `After the scene, a ${questionDraft.markGapSec}s pause, then this screen with voiceover and a ${questionDraft.markCountdownSec}s timer (3, 2, 1).`}
              </p>
              <label className="text-sm font-medium">Screen text</label>
              <input
                value={questionDraft.markText}
                onChange={(e) =>
                  onQuestionDraft((d) => ({
                    ...d,
                    markText: e.target.value,
                    ready: false,
                  }))
                }
                placeholder={
                  questionDraft.kind === "coding"
                    ? "Coding screen coming up in 3, 2, 1"
                    : "Mark your answers"
                }
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="font-medium">Gap before countdown (sec)</span>
                  <input
                    type="number"
                    min={0}
                    max={30}
                    value={questionDraft.markGapSec}
                    onChange={(e) =>
                      onQuestionDraft((d) => ({
                        ...d,
                        markGapSec: Math.max(0, Number(e.target.value) || 0),
                        ready: false,
                      }))
                    }
                    className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-sm">
                  <span className="font-medium">Countdown duration (sec)</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={questionDraft.markCountdownSec}
                    onChange={(e) =>
                      onQuestionDraft((d) => ({
                        ...d,
                        markCountdownSec: Math.max(1, Number(e.target.value) || 1),
                        ready: false,
                      }))
                    }
                    className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={generatingMarkTts}
                  onClick={onUseDefaultMarkTts}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-60"
                >
                  Use default voice
                </button>
                <button
                  type="button"
                  disabled={generatingMarkTts || questionDraft.markText.trim().length < 2}
                  onClick={onGenerateMarkTts}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {generatingMarkTts ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Mic size={16} />
                  )}
                  Generate countdown TTS
                </button>
              </div>
              {questionDraft.markAudioUrl && (
                <audio controls src={questionDraft.markAudioUrl} className="w-full max-w-md" />
              )}
              {questionDraft.markAudioUrl &&
                questionDraft.markAudioForText.trim() !== questionDraft.markText.trim() && (
                  <p className="text-xs text-amber-700">
                    Text changed — regenerate countdown TTS to match.
                  </p>
                )}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="tts">
          <AccordionTrigger>
            <StepTrigger done={questionStatus.tts} icon={Mic} label="2. Narration (TTS)" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <label className="text-sm font-medium">Narration script</label>
            <textarea
              value={questionDraft.script}
              onChange={(e) =>
                onQuestionDraft((d) => ({ ...d, script: e.target.value, ready: false }))
              }
              rows={5}
              placeholder="Voiceover while each part reveals…"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={generatingTts || !(questionStatus.contentOk ?? questionStatus.setup)}
              onClick={onQuestionTts}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {generatingTts ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
              Generate TTS
            </button>
            {!(questionStatus.contentOk ?? questionStatus.setup) && (
              <p className="text-xs text-amber-700">
                {questionDraft.kind === "coding"
                  ? "Fill fields from the template first (title, instruction, starter code, and at least one test case with Input + Output)."
                  : questionDraft.kind === "predictOutput"
                    ? "Fill in the question, code block, and all four options first."
                    : "Fill in the question and all four options first."}
              </p>
            )}
            {(questionStatus.contentOk ?? false) &&
              (!questionStatus.introAudioOk || !questionStatus.markAudioOk) && (
                <p className="text-xs text-muted-foreground">
                  Tip: still generate <span className="font-medium">intro TTS</span> and{" "}
                  <span className="font-medium">countdown TTS</span> in step 1 before preview/save.
                </p>
              )}
            {questionDraft.audioUrl && (
              <audio controls src={questionDraft.audioUrl} className="w-full max-w-md" />
            )}
            <NarrationUploadDivider />
            <ComposeAudioUpload
              value={questionDraft.audioUrl ?? null}
              onChange={onQuestionUploadNarration}
              disabled={generatingTts}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="preview">
          <AccordionTrigger>
            <StepTrigger done={questionStatus.preview} icon={Film} label="3. Preview" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <ComposeBackgroundPicker value={backgroundPreset} onChange={onBackgroundPreset} />
            <button
              type="button"
              disabled={!previewScene || !questionStatus.tts}
              onClick={onPreview}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <Film size={16} /> Preview scene
            </button>
            {showPreview && previewScene && (
              <VideoPlayer
                scenes={[previewScene]}
                background={previewBackground}
                projectId={projectId}
              />
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="save">
          <AccordionTrigger>
            <StepTrigger done={questionStatus.saveReady} icon={Save} label={`4. ${saveSceneLabel}`} />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            {!canSaveScene && (
              <p className="text-sm text-muted-foreground">
                Create a project and name your part at the top before saving scenes.
              </p>
            )}
            <button
              type="button"
              disabled={saving || !questionStatus.saveReady || !canSaveScene}
              onClick={onSave}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {sceneSaveButtonLabel}
            </button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  if (sourceMode === "recording2") {
    const saveSceneLabel = editingScene ? "Update scene in part" : "Add scene to part";
    return (
      <Accordion
        type="multiple"
        value={openSteps}
        onValueChange={onOpenSteps}
        className="rounded-lg border bg-card px-4"
      >
        <AccordionItem value="setup">
          <AccordionTrigger>
            <StepTrigger
              done={recordingStatus.setup && recordingStatus.tts}
              icon={Film}
              label="1. Upload screen recording"
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Upload a screen recording with your mic voice (English). We transcribe it, strip
              fillers (umm, hmm, …), show editable chunks, then you generate Kokoro (local) per
              chunk or all at once — original mic is discarded.
            </p>
            <p className="text-xs text-muted-foreground">
              Mac tip: ⌘⇧5 → Options → Microphone → pick your mic before recording. A video-only
              ReplayKit file will fail here.
            </p>
            <ComposeVideoUpload
              value={recordingDraft.mediaUrl}
              projectId={projectId}
              disabled={processingRecording2 || generatingTts}
              onUploaded={(result) => onRecording2VideoUploaded?.(result)}
              onClear={() =>
                onRecordingDraft((d) => ({
                  ...d,
                  mediaUrl: null,
                  sourceDurationMs: 0,
                  trimStartMs: 0,
                  trimEndMs: 0,
                  videoOffsetMs: 0,
                  videoSegments: [],
                  audioUrl: null,
                  audioDurationMs: 0,
                  audioSegments: [],
                  script: "",
                  voicePhrases: [],
                  useEmbeddedAudio: false,
                  voiceReplace: true,
                  cameraKeyframes: [
                    { atMs: 0, scale: 1, focusX: 0.5, focusY: 0.5, easing: "easeInOut" },
                  ],
                  cameraZoomDurationMs: 500,
                  cameraZoomSfx: "swoosh",
                  blurRegion: null,
                  highlights: [],
                  ready: false,
                }))
              }
            />
            {processingRecording2 && (
              <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={16} className="animate-spin" />
                Working on transcript / Kokoro voice…
              </p>
            )}
            {recordingDraft.mediaUrl && !processingRecording2 && (
              <video
                src={recordingDraft.mediaUrl}
                playsInline
                muted
                controls
                className="max-h-48 w-full rounded-md border bg-black object-contain"
              />
            )}
            {recordingDraft.ready && recordingDraft.audioUrl && (
              <p className="text-xs text-muted-foreground">
                Voice applied ({(recordingDraft.audioDurationMs / 1000).toFixed(1)}s Kokoro audio;
                original mic discarded)
              </p>
            )}
            {(recordingDraft.voicePhrases?.length ?? 0) > 0 && (
              <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Mic size={14} className="text-muted-foreground" />
                    Transcript chunks
                    <span className="text-xs font-normal text-muted-foreground">
                      ({recordingDraft.voicePhrases!.filter((p) => p.audioUrl).length}/
                      {recordingDraft.voicePhrases!.length} voiced)
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="inline-flex items-center gap-1.5 text-xs font-medium">
                      Voice
                      <select
                        value={recording2Voice}
                        disabled={processingRecording2}
                        onChange={(e) =>
                          onRecording2Voice?.(
                            e.target.value === "af_heart" ? "af_heart" : "am_michael",
                          )
                        }
                        className="rounded-md border bg-background px-2 py-1 text-xs"
                      >
                        <option value="am_michael">Michael</option>
                        <option value="af_heart">Heart</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={processingRecording2 || !recordingDraft.mediaUrl}
                      onClick={() => onRecording2GenerateAll?.()}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {processingRecording2 ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Mic size={12} />
                      )}
                      Generate all chunks
                    </button>
                    <button
                      type="button"
                      disabled={
                        processingRecording2 ||
                        !recordingDraft.mediaUrl ||
                        !(recordingDraft.voicePhrases ?? []).every((p) => !!p.audioUrl)
                      }
                      onClick={() => onRecording2AssembleVoice?.()}
                      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      title="Stitch already-generated chunk audio onto the muted video"
                    >
                      Apply voice to scene
                    </button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Edit any chunk, generate it alone to preview Kokoro for that line, or generate all
                  and apply in one step.
                </p>
                <div className="space-y-2">
                  {recordingDraft.voicePhrases!.map((phrase, index) => (
                    <div
                      key={phrase.id}
                      className="space-y-2 rounded-md border bg-background p-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Chunk {index + 1}
                          <span className="ml-1.5 font-normal normal-case tabular-nums">
                            {phrase.startSec.toFixed(1)}s–{phrase.endSec.toFixed(1)}s
                          </span>
                        </span>
                        <button
                          type="button"
                          disabled={
                            processingRecording2 || phrase.text.trim().length < 2
                          }
                          onClick={() => onRecording2GeneratePhrase?.(index)}
                          className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium hover:bg-accent disabled:opacity-50"
                        >
                          {recording2PhraseBusyIndex === index ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <Mic size={11} />
                          )}
                          {phrase.audioUrl ? "Regenerate chunk" : "Generate chunk"}
                        </button>
                      </div>
                      <textarea
                        value={phrase.text}
                        onChange={(e) => {
                          const text = e.target.value;
                          onRecordingDraft((d) => ({
                            ...d,
                            voicePhrases: (d.voicePhrases ?? []).map((p, i) =>
                              i === index
                                ? {
                                    ...p,
                                    text,
                                    audioUrl: null,
                                    audioDurationMs: 0,
                                  }
                                : p,
                            ),
                            script: (d.voicePhrases ?? [])
                              .map((p, i) => (i === index ? text : p.text))
                              .join(" ")
                              .replace(/\s+/g, " ")
                              .trim(),
                            ready: false,
                            audioUrl: null,
                            audioDurationMs: 0,
                            audioSegments: [],
                          }));
                        }}
                        rows={2}
                        disabled={processingRecording2}
                        className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm leading-relaxed"
                      />
                      {phrase.audioUrl && (
                        <audio
                          controls
                          src={phrase.audioUrl}
                          className="h-8 w-full max-w-md"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {recordingDraft.mediaUrl &&
              !processingRecording2 &&
              !(recordingDraft.voicePhrases?.length ?? 0) && (
                <p className="text-xs text-muted-foreground">
                  Transcript chunks appear here after upload finishes transcribing.
                </p>
              )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="edit">
          <AccordionTrigger>
            <StepTrigger
              done={recordingStatus.setup && recordingStatus.tts}
              icon={Layers}
              label="2. Edit (zoom, blur & highlight)"
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Add camera zooms, blur sensitive areas, and a timed hand-drawn rectangle highlight.
              Split, trim, and speed controls are not available here.
            </p>
            {recordingDraft.ready && recordingDraft.mediaUrl && recordingDraft.audioUrl ? (
              <RecordingTimeline
                draft={recordingDraft}
                features="cameraBlur"
                disabled={processingRecording2}
                onChange={(patch) => onRecordingDraft((d) => ({ ...d, ...patch }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {recordingDraft.voicePhrases?.length && !recordingDraft.ready
                  ? "Generate chunk voices (or Generate all), then Apply voice — then edit here."
                  : "Finish upload and voice replace in step 1 first."}
              </p>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="preview">
          <AccordionTrigger>
            <StepTrigger done={recordingStatus.preview} icon={Film} label="3. Preview" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <ComposeBackgroundPicker value={backgroundPreset} onChange={onBackgroundPreset} />
            <button
              type="button"
              disabled={!previewScene || !recordingStatus.tts || processingRecording2}
              onClick={onPreview}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <Film size={16} /> Preview scene
            </button>
            {showPreview && previewScene && (
              <VideoPlayer
                scenes={[previewScene]}
                background={previewBackground}
                projectId={projectId}
              />
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="save">
          <AccordionTrigger>
            <StepTrigger
              done={recordingStatus.saveReady}
              icon={Save}
              label={`4. ${saveSceneLabel}`}
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            {!canSaveScene && (
              <p className="text-sm text-muted-foreground">
                Create a project and name your part at the top before saving scenes.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Save this voice-replaced screen recording to the current part — it appears in the
              panel on the right.
            </p>
            <button
              type="button"
              disabled={
                saving || !recordingStatus.saveReady || !canSaveScene || processingRecording2
              }
              onClick={onSave}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {sceneSaveButtonLabel}
            </button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  if (sourceMode === "clip") {
    const saveSceneLabel = editingScene ? "Update scene in part" : "Add scene to part";
    return (
      <Accordion
        type="multiple"
        value={openSteps}
        onValueChange={onOpenSteps}
        className="rounded-lg border bg-card px-4"
      >
        <AccordionItem value="setup">
          <AccordionTrigger>
            <StepTrigger
              done={recordingStatus.setup && recordingStatus.tts}
              icon={Film}
              label="1. Upload video"
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Drop in a video that already has sound. It stretches to fill the frame over the
              background loop — no white card, no narration timeline.
            </p>
            <ComposeVideoUpload
              value={recordingDraft.mediaUrl}
              projectId={projectId}
              disabled={extractingClipAudio || generatingTts}
              onUploaded={(result) => onClipVideoUploaded?.(result)}
              onClear={() =>
                onRecordingDraft((d) => ({
                  ...d,
                  mediaUrl: null,
                  sourceDurationMs: 0,
                  trimStartMs: 0,
                  trimEndMs: 0,
                  videoOffsetMs: 0,
                  videoSegments: [],
                  audioUrl: null,
                  audioDurationMs: 0,
                  audioSegments: [],
                  useEmbeddedAudio: true,
                  cameraKeyframes: [
                    { atMs: 0, scale: 1, focusX: 0.5, focusY: 0.5, easing: "easeInOut" },
                  ],
                  cameraZoomDurationMs: 500,
                  cameraZoomSfx: "none",
                  blurRegion: null,
                  highlights: [],
                  ready: false,
                }))
              }
            />
            {extractingClipAudio && (
              <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={16} className="animate-spin" />
                Pulling audio from the video…
              </p>
            )}
            {recordingDraft.mediaUrl && !extractingClipAudio && (
              <video
                src={recordingDraft.mediaUrl}
                playsInline
                controls
                className="max-h-48 w-full rounded-md border bg-black object-contain"
              />
            )}
            {recordingDraft.ready && recordingDraft.audioUrl && (
              <p className="text-xs text-muted-foreground">
                Audio track ready ({(recordingDraft.audioDurationMs / 1000).toFixed(1)}s)
              </p>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="edit">
          <AccordionTrigger>
            <StepTrigger
              done={recordingStatus.setup && recordingStatus.tts}
              icon={Layers}
              label="2. Edit (zoom, blur & highlight)"
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Add camera zooms, blur sensitive areas, and a timed hand-drawn rectangle highlight.
              Split, trim, and speed controls are not available here.
            </p>
            {recordingDraft.ready && recordingDraft.mediaUrl && recordingDraft.audioUrl ? (
              <RecordingTimeline
                draft={recordingDraft}
                features="cameraBlur"
                disabled={extractingClipAudio}
                onChange={(patch) => onRecordingDraft((d) => ({ ...d, ...patch }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Finish upload and audio extract in step 1 first.
              </p>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="preview">
          <AccordionTrigger>
            <StepTrigger done={recordingStatus.preview} icon={Film} label="3. Preview" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <ComposeBackgroundPicker value={backgroundPreset} onChange={onBackgroundPreset} />
            <button
              type="button"
              disabled={!previewScene || !recordingStatus.tts}
              onClick={onPreview}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <Film size={16} /> Preview scene
            </button>
            {showPreview && previewScene && (
              <VideoPlayer
                scenes={[previewScene]}
                background={previewBackground}
                projectId={projectId}
              />
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="save">
          <AccordionTrigger>
            <StepTrigger
              done={recordingStatus.saveReady}
              icon={Save}
              label={`4. ${saveSceneLabel}`}
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            {!canSaveScene && (
              <p className="text-sm text-muted-foreground">
                Create a project and name your part at the top before saving scenes.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Save this video clip to the current part — it appears in the panel on the right.
            </p>
            <button
              type="button"
              disabled={saving || !recordingStatus.saveReady || !canSaveScene || extractingClipAudio}
              onClick={onSave}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {sceneSaveButtonLabel}
            </button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  if (sourceMode === "recording") {
    return (
      <Accordion
        type="multiple"
        value={openSteps}
        onValueChange={onOpenSteps}
        className="rounded-lg border bg-card px-4"
      >
        <AccordionItem value="setup">
          <AccordionTrigger>
            <StepTrigger
              done={recordingStatus.setup}
              icon={Film}
              label="1. Upload screen recording"
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Recording plays inside the white card over the background loop. Original mic audio
              is ignored — use TTS for narration.
            </p>
            <ComposeVideoUpload
              value={recordingDraft.mediaUrl}
              projectId={projectId}
              disabled={generatingTts}
              onUploaded={({ url, durationMs }) =>
                onRecordingDraft((d) => ({
                  ...d,
                  mediaUrl: url,
                  sourceDurationMs: durationMs,
                  trimStartMs: 0,
                  trimEndMs: durationMs,
                  videoOffsetMs: 0,
                  videoSegments: [
                    {
                      id: `vid-${Date.now().toString(36)}`,
                      trimStartMs: 0,
                      trimEndMs: durationMs,
                      offsetMs: 0,
                      rate: 1,
                    },
                  ],
                  cameraKeyframes: [{ atMs: 0, scale: 1, focusX: 0.5, focusY: 0.5, easing: "easeInOut" }],
                  cameraZoomDurationMs: 500,
                  cameraZoomSfx: "swoosh",
                  blurRegion: null,
                  highlights: [],
                  ready: d.ready && !!d.audioUrl,
                }))
              }
              onClear={() =>
                onRecordingDraft((d) => ({
                  ...d,
                  mediaUrl: null,
                  sourceDurationMs: 0,
                  trimStartMs: 0,
                  trimEndMs: 0,
                  videoOffsetMs: 0,
                  videoSegments: [],
                  cameraKeyframes: [{ atMs: 0, scale: 1, focusX: 0.5, focusY: 0.5, easing: "easeInOut" }],
                  cameraZoomDurationMs: 500,
                  cameraZoomSfx: "swoosh",
                  blurRegion: null,
                  highlights: [],
                  ready: false,
                }))
              }
            />
            {recordingDraft.mediaUrl && (
              <video
                src={recordingDraft.mediaUrl}
                muted
                playsInline
                controls
                className="max-h-48 w-full rounded-md border bg-black object-contain"
              />
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="tts">
          <AccordionTrigger>
            <StepTrigger done={recordingStatus.tts} icon={Mic} label="2. Narration (TTS)" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <label className="text-sm font-medium">Narration script</label>
            <textarea
              value={recordingDraft.script}
              onChange={(e) =>
                onRecordingDraft((d) => ({ ...d, script: e.target.value, ready: false }))
              }
              rows={4}
              placeholder="What the voiceover says while the recording plays…"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={generatingTts || !recordingDraft.mediaUrl}
              onClick={onRecordingTts}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {generatingTts ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
              Generate TTS
            </button>
            {recordingDraft.audioUrl && (
              <audio controls src={recordingDraft.audioUrl} className="w-full max-w-md" />
            )}
            <NarrationUploadDivider />
            <ComposeAudioUpload
              value={recordingDraft.audioUrl ?? null}
              onChange={onRecordingUploadNarration}
              disabled={generatingTts}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="timeline">
          <AccordionTrigger>
            <StepTrigger
              done={recordingStatus.setup && recordingStatus.tts}
              icon={Layers}
              label="3. Sync timeline"
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <RecordingTimeline
              draft={recordingDraft}
              disabled={generatingTts}
              onChange={(patch) => onRecordingDraft((d) => ({ ...d, ...patch }))}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="preview">
          <AccordionTrigger>
            <StepTrigger done={recordingStatus.preview} icon={Film} label="4. Preview" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <ComposeBackgroundPicker value={backgroundPreset} onChange={onBackgroundPreset} />
            <button
              type="button"
              disabled={!previewScene || !recordingStatus.tts}
              onClick={onPreview}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <Film size={16} /> Preview scene
            </button>
            {showPreview && previewScene && (
              <VideoPlayer
                scenes={[previewScene]}
                background={previewBackground}
                projectId={projectId}
              />
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="save">
          <AccordionTrigger>
            <StepTrigger
              done={recordingStatus.saveReady}
              icon={Save}
              label={`5. ${saveSceneLabel}`}
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            {!canSaveScene && (
              <p className="text-sm text-muted-foreground">
                Create a project and name your part at the top before saving scenes.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Scenes auto-save to this Mac as soon as they’re ready — no Save click needed.
            </p>
            <button
              type="button"
              disabled={saving || !recordingStatus.saveReady || !canSaveScene}
              onClick={onSave}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {sceneSaveButtonLabel}
            </button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  if (sourceMode === "code") {
    const isTyping = codeDraft.codeVariant === "typing";
    const typingBeats =
      codeDraft.codeTypingBeats?.length
        ? codeDraft.codeTypingBeats
        : [
            emptyCodeTypingBeat({
              code: codeDraft.code,
              output: codeDraft.codeOutput ?? "",
              runDelayMs: codeDraft.codeRunDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS,
              outputHoldMs: codeDraft.codeOutputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS,
            }),
          ];

    return (
      <Accordion
        type="multiple"
        value={openSteps}
        onValueChange={onOpenSteps}
        className="rounded-lg border bg-card px-4"
      >
        <AccordionItem value="setup">
          <AccordionTrigger>
            <StepTrigger done={codeStatus.setup} icon={Sparkles} label="1. Code scene setup" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <label className="text-sm font-medium">
                Language
                <select
                  value={codeDraft.codeLanguage}
                  onChange={(e) =>
                    onCodeDraft((d) => ({ ...d, codeLanguage: e.target.value, ready: false }))
                  }
                  className="ml-2 rounded-md border bg-background px-2 py-1 text-sm"
                >
                  <option value="py">Python</option>
                  <option value="ts">TypeScript</option>
                  <option value="tsx">TSX</option>
                  <option value="js">JavaScript</option>
                  <option value="sh">Shell</option>
                  <option value="json">JSON</option>
                </select>
              </label>
              <label className="text-sm font-medium">
                Animation
                <select
                  value={codeDraft.codeVariant}
                  onChange={(e) => {
                    const codeVariant = e.target.value as ComposeCodeDraft["codeVariant"];
                    onCodeDraft((d) => {
                      if (codeVariant !== "typing") {
                        return { ...d, codeVariant, ready: false };
                      }
                      const beats =
                        d.codeTypingBeats?.length &&
                        d.codeTypingBeats.some((b) => b.code.trim())
                          ? d.codeTypingBeats
                          : [
                              emptyCodeTypingBeat({
                                code: d.code,
                                output: d.codeOutput ?? "",
                                runDelayMs: d.codeRunDelayMs ?? DEFAULT_CODE_RUN_DELAY_MS,
                                outputHoldMs: d.codeOutputHoldMs ?? DEFAULT_CODE_OUTPUT_HOLD_MS,
                              }),
                            ];
                      return {
                        ...d,
                        codeVariant,
                        codeTypingBeats: beats,
                        code: beatsToFullCode(beats),
                        codeOutput: beats[0]?.output ?? "",
                        codeRunDelayMs: beats[0]?.runDelayMs,
                        codeOutputHoldMs: beats[0]?.outputHoldMs,
                        typingSpeedCps: d.typingSpeedCps ?? DEFAULT_CODE_TYPING_CPS,
                        ready: false,
                      };
                    });
                  }}
                  className="ml-2 rounded-md border bg-background px-2 py-1 text-sm"
                >
                  <option value="typing">Typing</option>
                  <option value="scroll">Scroll</option>
                  <option value="flight">Flight</option>
                </select>
              </label>
            </div>

            {isTyping ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Stepwise typing with Run + output. Narration
                  still comes from the TTS step below.
                </p>
                <label className="block text-sm font-medium">
                  Typing speed (chars / sec)
                  <input
                    type="number"
                    min={8}
                    max={80}
                    step={1}
                    value={codeDraft.typingSpeedCps ?? DEFAULT_CODE_TYPING_CPS}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      onCodeDraft((d) => ({
                        ...d,
                        typingSpeedCps: Number.isFinite(v)
                          ? Math.max(8, Math.min(80, Math.round(v)))
                          : DEFAULT_CODE_TYPING_CPS,
                        ready: false,
                      }));
                    }}
                    className="mt-1 w-28 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Code font size (px)
                  <input
                    type="number"
                    min={10}
                    max={48}
                    step={1}
                    value={codeDraft.codeFontSize ?? 14}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      onCodeDraft((d) => ({
                        ...d,
                        codeFontSize: Number.isFinite(v)
                          ? Math.max(10, Math.min(48, Math.round(v)))
                          : 14,
                        ready: false,
                      }));
                    }}
                    className="mt-1 w-28 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums"
                  />
                </label>
                <div className="space-y-3">
                  {typingBeats.map((beat, index) => (
                    <div
                      key={beat.id}
                      className="space-y-2 rounded-lg border bg-muted/20 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          Step {index + 1}
                          {index > 0 ? (
                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                              (continues from previous)
                            </span>
                          ) : null}
                        </p>
                        {typingBeats.length > 1 ? (
                          <button
                            type="button"
                            onClick={() =>
                              onCodeDraft((d) => {
                                const list = d.codeTypingBeats?.length
                                  ? d.codeTypingBeats
                                  : typingBeats;
                                const next = list.filter((b) => b.id !== beat.id);
                                return {
                                  ...d,
                                  codeTypingBeats: next,
                                  code: beatsToFullCode(next),
                                  codeOutput: next[0]?.output ?? "",
                                  codeRunDelayMs: next[0]?.runDelayMs,
                                  codeOutputHoldMs: next[0]?.outputHoldMs,
                                  ready: false,
                                };
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 size={12} /> Remove
                          </button>
                        ) : null}
                      </div>
                      <label className="block text-xs font-medium text-muted-foreground">
                        Code typed in this step
                        <textarea
                          value={beat.code}
                          onChange={(e) => {
                            const value = e.target.value;
                            onCodeDraft((d) => {
                              const list = d.codeTypingBeats?.length
                                ? d.codeTypingBeats
                                : typingBeats;
                              const next = list.map((b) =>
                                b.id === beat.id ? { ...b, code: value } : b,
                              );
                              return {
                                ...d,
                                codeTypingBeats: next,
                                code: beatsToFullCode(next),
                                codeVariant: "typing",
                                ready: false,
                              };
                            });
                          }}
                          rows={index === 0 ? 10 : 5}
                          spellCheck={false}
                          className="mt-1 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs leading-relaxed text-slate-800"
                          placeholder={
                            index === 0 ? DEFAULT_CODE_TYPING_SNIPPET : "# more code…"
                          }
                        />
                      </label>
                      <label className="block text-xs font-medium text-muted-foreground">
                        Output after Run
                        <textarea
                          value={beat.output}
                          onChange={(e) => {
                            const value = e.target.value;
                            onCodeDraft((d) => {
                              const list = d.codeTypingBeats?.length
                                ? d.codeTypingBeats
                                : typingBeats;
                              const next = list.map((b) =>
                                b.id === beat.id ? { ...b, output: value } : b,
                              );
                              return {
                                ...d,
                                codeTypingBeats: next,
                                codeOutput: next[0]?.output ?? value,
                                ready: false,
                              };
                            });
                          }}
                          rows={3}
                          spellCheck={false}
                          className="mt-1 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs leading-relaxed text-slate-800"
                          placeholder={DEFAULT_CODE_TYPING_OUTPUT}
                        />
                      </label>
                      <div className="flex flex-wrap gap-4">
                        <label className="text-xs font-medium text-muted-foreground">
                          Output shows for (sec)
                          <input
                            type="number"
                            min={0.5}
                            max={60}
                            step={0.5}
                            value={beat.outputHoldMs / 1000}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              const sec = Number.isFinite(v)
                                ? Math.max(0.5, Math.min(60, v))
                                : 2.5;
                              onCodeDraft((d) => {
                                const list = d.codeTypingBeats?.length
                                  ? d.codeTypingBeats
                                  : typingBeats;
                                const next = list.map((b) =>
                                  b.id === beat.id
                                    ? { ...b, outputHoldMs: Math.round(sec * 1000) }
                                    : b,
                                );
                                return {
                                  ...d,
                                  codeTypingBeats: next,
                                  codeOutputHoldMs: next[0]?.outputHoldMs,
                                  ready: false,
                                };
                              });
                            }}
                            className="mt-1 block w-24 rounded-md border bg-background px-2 py-1 text-sm tabular-nums"
                          />
                        </label>
                        <label className="text-xs font-medium text-muted-foreground">
                          Run delay (sec)
                          <input
                            type="number"
                            min={0}
                            max={10}
                            step={0.1}
                            value={beat.runDelayMs / 1000}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              const sec = Number.isFinite(v)
                                ? Math.max(0, Math.min(10, v))
                                : 0.7;
                              onCodeDraft((d) => {
                                const list = d.codeTypingBeats?.length
                                  ? d.codeTypingBeats
                                  : typingBeats;
                                const next = list.map((b) =>
                                  b.id === beat.id
                                    ? { ...b, runDelayMs: Math.round(sec * 1000) }
                                    : b,
                                );
                                return {
                                  ...d,
                                  codeTypingBeats: next,
                                  codeRunDelayMs: next[0]?.runDelayMs,
                                  ready: false,
                                };
                              });
                            }}
                            className="mt-1 block w-24 rounded-md border bg-background px-2 py-1 text-sm tabular-nums"
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      onCodeDraft((d) => {
                        const list = d.codeTypingBeats?.length
                          ? d.codeTypingBeats
                          : typingBeats;
                        const next = [
                          ...list,
                          emptyCodeTypingBeat({
                            code: "\n",
                            output: "",
                            runDelayMs: DEFAULT_CODE_RUN_DELAY_MS,
                            outputHoldMs: DEFAULT_CODE_OUTPUT_HOLD_MS,
                          }),
                        ];
                        return {
                          ...d,
                          codeVariant: "typing",
                          codeTypingBeats: next,
                          code: beatsToFullCode(next),
                          ready: false,
                        };
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                  >
                    <Plus size={14} /> Add step (more code + Run output)
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="text-sm font-medium">Code snippet</label>
                <textarea
                  value={codeDraft.code}
                  onChange={(e) =>
                    onCodeDraft((d) => ({ ...d, code: e.target.value, ready: false }))
                  }
                  rows={12}
                  placeholder={"from openai import OpenAI\n\nclient = OpenAI()\n..."}
                  className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                />
              </>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="tts">
          <AccordionTrigger>
            <StepTrigger done={codeStatus.tts} icon={Mic} label="2. Narration (TTS)" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <label className="text-sm font-medium">Narration script</label>
            <textarea
              value={codeDraft.script}
              onChange={(e) => onCodeDraft((d) => ({ ...d, script: e.target.value, ready: false }))}
              rows={4}
              placeholder="What the voiceover says while the code types…"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={generatingTts}
              onClick={onCodeTts}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {generatingTts ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
              Generate TTS
            </button>
            {codeDraft.audioUrl && (
              <audio controls src={codeDraft.audioUrl} className="w-full max-w-md" />
            )}
            <NarrationUploadDivider />
            <ComposeAudioUpload
              value={codeDraft.audioUrl ?? null}
              onChange={onCodeUploadNarration}
              disabled={generatingTts}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="preview">
          <AccordionTrigger>
            <StepTrigger done={codeStatus.preview} icon={Film} label="3. Preview" />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <ComposeBackgroundPicker value={backgroundPreset} onChange={onBackgroundPreset} />
            <button
              type="button"
              disabled={!previewScene || !codeStatus.tts}
              onClick={onPreview}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <Film size={16} /> Preview scene
            </button>
            {showPreview && previewScene && (
              <VideoPlayer
                scenes={[previewScene]}
                background={previewBackground}
                projectId={projectId}
              />
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="save">
          <AccordionTrigger>
            <StepTrigger done={codeStatus.saveReady} icon={Save} label={`4. ${saveSceneLabel}`} />
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            {!canSaveScene && (
              <p className="text-sm text-muted-foreground">
                Create a project and name your part at the top before saving scenes.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Scenes auto-save to this Mac as soon as they’re ready — no Save click needed.
            </p>
            <button
              type="button"
              disabled={saving || !codeStatus.saveReady || !canSaveScene}
              onClick={onSave}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {sceneSaveButtonLabel}
            </button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  const imageLabel =
    sourceMode === "upload" ? "1. Upload composite image" : "1. Generate composite image";

  return (
    <Accordion
      type="multiple"
      value={openSteps}
      onValueChange={onOpenSteps}
      className="rounded-lg border bg-card px-4"
    >
      <AccordionItem value="image">
        <AccordionTrigger>
          <StepTrigger done={imageStatus.image} icon={ImageIcon} label={imageLabel} />
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          {sourceMode === "upload" ? (
            <>
              <ComposeImageUpload
                value={uploadDataUrl}
                onChange={onUploadChange}
                disabled={generatingImage}
              />
              {draft.compositeUrl && (
                <img
                  src={draft.compositeUrl}
                  alt=""
                  className="max-h-48 rounded-md border object-contain"
                />
              )}
            </>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={useDirectImagePrompt}
                  onChange={(e) => onUseDirectImagePrompt(e.target.checked)}
                  className="rounded border"
                />
                <span className="font-medium">Custom image prompt</span>
                <span className="text-muted-foreground">— used as the source content</span>
              </label>
              {useDirectImagePrompt ? (
                <textarea
                  value={directImagePrompt}
                  onChange={(e) => onDirectImagePrompt(e.target.value)}
                  rows={10}
                  placeholder={`Create an Excalidraw style image for this text:\n\n...\n\nVisual style:\n...`}
                  className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                />
              ) : (
                <textarea
                  value={draft.script}
                  onChange={(e) => onDraftScript(e.target.value)}
                  rows={5}
                  placeholder="Script used to generate the composite image…"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
                />
              )}
              <button
                type="button"
                disabled={generatingImage}
                onClick={onGenerateImage}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
              >
                {generatingImage ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <ImageIcon size={16} />
                )}
                Generate image
              </button>
              {lastImagePrompt && (
                <details className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                  <summary className="cursor-pointer font-medium text-muted-foreground">
                    Image prompt sent to gpt-image-1 (exact)
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                    {lastImagePrompt}
                  </pre>
                </details>
              )}
              {draft.compositeUrl && (
                <img
                  src={draft.compositeUrl}
                  alt=""
                  className="max-h-48 rounded-md border object-contain"
                />
              )}
            </>
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="tts">
        <AccordionTrigger>
          <StepTrigger done={imageStatus.tts} icon={Mic} label="2. Narration (TTS)" />
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <label className="text-sm font-medium">Narration script</label>
          <textarea
            value={draft.script}
            onChange={(e) => onDraftScript(e.target.value)}
            rows={5}
            placeholder="Paste the narration for this scene…"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={generatingTts || !imageStatus.image}
            onClick={onGenerateTts}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {generatingTts ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
            Generate TTS
          </button>
          {draft.audioUrl && (
            <audio controls src={draft.audioUrl} className="w-full max-w-md" />
          )}
          {draft.audioUrl && (
            <BasicAudioEditor
              audioUrl={draft.audioUrl}
              disabled={generatingTts}
              onApply={onUploadNarration}
            />
          )}
          <NarrationUploadDivider />
          <ComposeAudioUpload
            value={draft.audioUrl ?? null}
            onChange={onUploadNarration}
            disabled={generatingTts}
          />
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="crop">
        <AccordionTrigger>
          <StepTrigger done={imageStatus.crop} icon={Layers} label="3. Layer elements" />
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          {!draft.compositeUrl ? (
            <p className="text-sm text-muted-foreground">Complete the image step first.</p>
          ) : (
            <>
              {segmentingLayers && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  Detecting layers with SAM 2…
                </p>
              )}
              <CropCanvas
                imageUrl={draft.compositeUrl}
                bgAspect={draft.bgAspect}
                crops={draft.crops}
                onAddCrop={onAddCrop}
                selectedCropId={selectedCropId}
                onSelectCrop={onSelectCrop}
              />
              {draft.crops.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Click a cropped element to draw on it (pen, colors, eraser), then save.
                </p>
              )}
              {draft.crops.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {draft.crops.map((c) => (
                    <div
                      key={c.id}
                      className={`rounded-lg border bg-card p-2 ${
                        selectedCropId === c.id ? "ring-2 ring-primary" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="group relative block w-full text-left"
                        onClick={() => {
                          onSelectCrop(c.id);
                          onAnnotateCrop(c.id);
                        }}
                        title="Click to draw / edit"
                      >
                        <img
                          src={c.imageUrl}
                          alt=""
                          className="aspect-square w-full rounded object-contain bg-white"
                        />
                        <span className="pointer-events-none absolute inset-x-0 bottom-7 flex justify-center opacity-0 transition group-hover:opacity-100">
                          <span className="inline-flex items-center gap-1 rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white">
                            <Pencil size={10} /> Edit
                          </span>
                        </span>
                        <p className="mt-1 truncate text-xs font-medium">{c.name}</p>
                      </button>
                      <div className="mt-1 flex gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectCrop(c.id);
                            onAnnotateCrop(c.id);
                          }}
                          className="flex flex-1 items-center justify-center gap-1 rounded border py-0.5 text-xs hover:bg-accent"
                        >
                          <Pencil size={12} /> Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveCrop(c.id)}
                          className="flex flex-1 items-center justify-center gap-1 rounded border py-0.5 text-xs text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 size={12} /> Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="timeline">
        <AccordionTrigger>
          <StepTrigger done={imageStatus.timeline} icon={Sparkles} label="4. Timeline placements" />
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          {!draft.audioUrl ? (
            <p className="text-sm text-muted-foreground">Complete the TTS step first.</p>
          ) : draft.crops.length === 0 ? (
            <p className="text-sm text-muted-foreground">Add at least one layer first.</p>
          ) : (
            <AudioTimeline
              audioUrl={draft.audioUrl}
              durationMs={draft.durationMs}
              crops={draft.crops}
              placements={draft.placements}
              selectedCropId={selectedCropId}
              onSelectCrop={onSelectCrop}
              onDuration={onDuration}
              onAddPlacement={onAddPlacement}
              onUpdatePlacement={onUpdatePlacement}
              onRemovePlacement={onRemovePlacement}
              onSeek={() => {}}
            />
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="preview">
        <AccordionTrigger>
          <StepTrigger done={imageStatus.preview} icon={Film} label="5. Preview" />
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <ComposeBackgroundPicker value={backgroundPreset} onChange={onBackgroundPreset} />
          <button
            type="button"
            disabled={!previewScene || draft.placements.length === 0}
            onClick={onPreview}
            className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <Film size={16} /> Preview scene
          </button>
          {showPreview && previewScene && (
            <VideoPlayer
              scenes={[previewScene]}
              background={previewBackground}
              projectId={projectId}
            />
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="save">
        <AccordionTrigger>
          <StepTrigger done={imageStatus.saveReady} icon={Save} label={`6. ${saveSceneLabel}`} />
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          {!canSaveScene && (
            <p className="text-sm text-muted-foreground">
              Create a project and name your part at the top before saving scenes.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Scenes auto-save to this Mac as soon as they’re ready — no Save click needed.
          </p>
          <button
            type="button"
            disabled={saving || !imageStatus.saveReady || !canSaveScene}
            onClick={onSave}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {sceneSaveButtonLabel}
          </button>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
