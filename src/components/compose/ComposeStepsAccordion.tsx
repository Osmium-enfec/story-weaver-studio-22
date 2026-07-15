import type { ComponentType } from "react";
import {
  CheckCircle2,
  Film,
  ImageIcon,
  Loader2,
  Mic,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
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
  type ComposeSourceMode,
} from "@/lib/compose-scene";
import type { SceneBackground } from "@/lib/scene-background";
import { ComposeBackgroundPicker } from "@/components/compose/ComposeBackgroundPicker";
import type { ComposeBackgroundPreset } from "@/lib/compose-background";
import { QUESTION_KIND_LABELS, type QuestionKind } from "@/lib/compose-question";
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
}

interface ComposeStepsAccordionProps {
  sourceMode: ComposeSourceMode;
  openSteps: string[];
  onOpenSteps: (steps: string[]) => void;
  draft: ComposeDraft;
  codeDraft: ComposeCodeDraft;
  questionDraft: ComposeQuestionDraft;
  uploadDataUrl: string | null;
  onUploadChange: (url: string | null) => void;
  useDirectImagePrompt: boolean;
  onUseDirectImagePrompt: (v: boolean) => void;
  directImagePrompt: string;
  onDirectImagePrompt: (v: string) => void;
  lastImagePrompt: string | null;
  generatingImage: boolean;
  generatingTts: boolean;
  saving: boolean;
  showPreview: boolean;
  canSaveScene: boolean;
  selectedCropId: string | null;
  onSelectCrop: (id: string | null) => void;
  previewScene: Scene | null;
  imageStatus: ImageStepStatus;
  codeStatus: CodeStepStatus;
  questionStatus: CodeStepStatus;
  onDraftScript: (script: string) => void;
  onCodeDraft: (fn: (d: ComposeCodeDraft) => ComposeCodeDraft) => void;
  onQuestionDraft: (fn: (d: ComposeQuestionDraft) => ComposeQuestionDraft) => void;
  onGenerateImage: () => void;
  onGenerateTts: () => void;
  onCodeTts: () => void;
  onQuestionTts: () => void;
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
  onAddPlacement: (cropId: string, startMs: number, sfxUrl?: string | null) => void;
  onUpdatePlacement: (id: string, patch: { sfxUrl?: string | null }) => void;
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
  uploadDataUrl,
  onUploadChange,
  useDirectImagePrompt,
  onUseDirectImagePrompt,
  directImagePrompt,
  onDirectImagePrompt,
  lastImagePrompt,
  generatingImage,
  generatingTts,
  saving,
  showPreview,
  canSaveScene,
  selectedCropId,
  onSelectCrop,
  previewScene,
  imageStatus,
  codeStatus,
  questionStatus,
  onDraftScript,
  onCodeDraft,
  onQuestionDraft,
  onGenerateImage,
  onGenerateTts,
  onCodeTts,
  onQuestionTts,
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
  const saveSceneLabel = editingScene ? "Update scene in part" : "Save scene to part";

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
              {(["mcq", "msq"] as QuestionKind[]).map((kind) => (
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
            <p className="text-xs text-muted-foreground">
              Paste a question in any format — AI fills the fields below. Correct answer is optional.
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

            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-semibold">Intro page</p>
              <p className="text-xs text-muted-foreground">
                Before the question: this screen with voiceover, then a {questionDraft.introGapSec}s
                pause, then the question reveals.
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
                placeholder="Now test your understanding"
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
                After the question, a {questionDraft.markGapSec}s pause, then this screen with
                voiceover and a {questionDraft.markCountdownSec}s timer.
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
                placeholder="Mark your answers"
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
              disabled={generatingTts || !questionStatus.setup}
              onClick={onQuestionTts}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {generatingTts ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
              Generate TTS
            </button>
            {questionDraft.audioUrl && (
              <audio controls src={questionDraft.audioUrl} className="w-full max-w-md" />
            )}
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
              <VideoPlayer scenes={[previewScene]} background={previewBackground} />
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
              {saving ? "Saving…" : saveSceneLabel}
            </button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  if (sourceMode === "code") {
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
                  onChange={(e) =>
                    onCodeDraft((d) => ({
                      ...d,
                      codeVariant: e.target.value as ComposeCodeDraft["codeVariant"],
                      ready: false,
                    }))
                  }
                  className="ml-2 rounded-md border bg-background px-2 py-1 text-sm"
                >
                  <option value="typing">Typing</option>
                  <option value="scroll">Scroll</option>
                  <option value="flight">Flight</option>
                </select>
              </label>
            </div>
            <label className="text-sm font-medium">Code snippet</label>
            <textarea
              value={codeDraft.code}
              onChange={(e) => onCodeDraft((d) => ({ ...d, code: e.target.value, ready: false }))}
              rows={12}
              placeholder={'from openai import OpenAI\n\nclient = OpenAI()\n...'}
              className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
            />
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
              <VideoPlayer scenes={[previewScene]} background={previewBackground} />
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
              Save this scene to the current part — it appears in the panel on the right.
            </p>
            <button
              type="button"
              disabled={saving || !codeStatus.saveReady || !canSaveScene}
              onClick={onSave}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? "Saving…" : saveSceneLabel}
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
                <span className="text-muted-foreground">— sent exactly to gpt-image-1</span>
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
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="crop">
        <AccordionTrigger>
          <StepTrigger done={imageStatus.crop} icon={Scissors} label="3. Crop elements" />
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          {!draft.compositeUrl ? (
            <p className="text-sm text-muted-foreground">Complete the image step first.</p>
          ) : (
            <>
              <CropCanvas
                imageUrl={draft.compositeUrl}
                bgAspect={draft.bgAspect}
                crops={draft.crops}
                onAddCrop={onAddCrop}
                selectedCropId={selectedCropId}
                onSelectCrop={onSelectCrop}
              />
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
                        className="block w-full text-left"
                        onClick={() => onSelectCrop(c.id)}
                      >
                        <img
                          src={c.imageUrl}
                          alt=""
                          className="aspect-square w-full rounded object-contain bg-white"
                        />
                        <p className="mt-1 truncate text-xs font-medium">{c.name}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveCrop(c.id)}
                        className="mt-1 flex w-full items-center justify-center gap-1 rounded border py-0.5 text-xs text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 size={12} /> Remove
                      </button>
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
            <p className="text-sm text-muted-foreground">Add at least one crop first.</p>
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
            <VideoPlayer scenes={[previewScene]} background={previewBackground} />
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
            Save this scene to the current part — stitch when all scenes are ready.
          </p>
          <button
            type="button"
            disabled={saving || !imageStatus.saveReady || !canSaveScene}
            onClick={onSave}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {saving ? "Saving…" : saveSceneLabel}
          </button>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
