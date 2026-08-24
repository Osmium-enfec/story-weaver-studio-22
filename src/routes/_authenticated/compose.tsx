import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { NavBar } from "@/components/NavBar";
import { ComposeProjectPanel } from "@/components/compose/ComposeProjectPanel";
import { ComposeStepsAccordion } from "@/components/compose/ComposeStepsAccordion";
import { CropAnnotateDialog } from "@/components/compose/CropAnnotateDialog";
import { generateComposeImage } from "@/lib/compose.functions";
import { autoLayersFromComposite } from "@/lib/compose-auto-layers";
import {
  fetchImageAsDataUrl,
  segmentImageLayers,
} from "@/lib/segment-layers.functions";
import type { ImageAspect, ImageModelId } from "@/lib/replicate-image";

/** Image generation is pinned: no model/aspect pickers in the UI. */
const IMAGE_MODEL: ImageModelId = "nano-banana-2";
const IMAGE_ASPECT: ImageAspect = "16:9";
import {
  apiEnsureIntroDefaultTts,
  apiEnsureMarkDefaultTts,
  apiEnsureCodingIntroDefaultTts,
  apiEnsureCodingMarkDefaultTts,
  apiEnsureFixedTemplateTts,
  apiGenerateIntroTts,
  apiGenerateMarkTts,
  apiGenerateCodingIntroTts,
  apiGenerateCodingMarkTts,
  apiGenerateTts,
  apiParseQuestion,
  apiExtractVideoAudio,
  apiRecording2VoiceReplace,
  apiPersistAsset,
} from "@/lib/compose-api";
import { apiGetProject, apiSaveProject } from "@/lib/projects-api";
import { getStoredSession } from "@/lib/auth-client";
import { rememberLastProject } from "@/lib/compose-last-project";
import {
  clearComposeWorkingDraft,
  composeWorkingDraftHasContent,
  readComposeWorkingDraft,
  writeComposeWorkingDraft,
} from "@/lib/compose-working-draft";
import { getProjectParts, defaultPartTitle } from "@/lib/project-parts";
import {
  commonIntroOutroRecordingDraft,
  commonIntroOutroScene,
} from "@/lib/common-intro-outro";
import {
  emptyPartScriptPlan,
  mergeScriptPlanWithComposeScenes,
  normalizePartScriptScene,
  partScriptPlanFromPart,
  partScriptPlanHasContent,
  partScriptPlanToText,
  syncScriptPlanWithComposeScenes,
  alignScriptAndComposeScenes,
  composeStubFromScriptScene,
  composeIdFromScriptSceneId,
  sceneCompletionProgress,
  partSceneCompletionList,
  composeModeForPartScriptType,
  type PartScriptPlan,
  type PartScriptScene,
} from "@/lib/part-script";
import {
  composeCodeDraftToScene,
  composeDraftToScene,
  composeQuestionDraftToScene,
  composeRecordingDraftToScene,
  composeTemplateDraftToScene,
  emptyComposeCodeDraft,
  emptyComposeDraft,
  emptyComposeQuestionDraft,
  emptyComposeRecordingDraft,
  singleRecordingAudioSegment,
  emptyComposeTemplateDraft,
  fixedTemplateDraftFromPreset,
  isRecordingLikeMode,
  sceneSourceMode,
  sceneToCodeDraft,
  sceneToComposeDraft,
  sceneToQuestionDraft,
  sceneToRecordingDraft,
  sceneToTemplateDraft,
  stripSceneStitchMetadata,
  type ComposeCodeDraft,
  type ComposeCrop,
  type ComposeDraft,
  type ComposeQuestionDraft,
  type ComposeRecordingDraft,
  type ComposeTemplateDraft,
  type ComposeSourceMode,
  type FixedTemplatePresetId,
} from "@/lib/compose-scene";
import type { Scene } from "@/components/VideoPlayer";
import type { ProjectPart } from "@/lib/project-parts";
import { probeAudioDurationMs } from "@/lib/audio-duration";
import { toPlayableAudioUrl } from "@/lib/playable-audio-url";
import { persistSceneAssetsForSave } from "@/lib/persist-client-asset";
import { createSilentAudioUrl } from "@/lib/audio-concat";
import {
  beatsToFullCode,
  DEFAULT_CODE_TYPING_CPS,
  emptyCodeTypingBeat,
  resolveCodeTypingBeats,
  suggestedBeatsDurationMs,
} from "@/lib/code-scene-sfx";
import {
  DEFAULT_CODE_TYPING_OUTPUT,
  DEFAULT_CODE_TYPING_SNIPPET,
} from "@/lib/format-python";
import type { QuestionKind } from "@/lib/compose-scene";
import {
  buildQuestionNarration,
  parseCorrectLetters,
} from "@/lib/question-scene-layout";
import { parseQuestionTextFallback, type ParsedQuestion } from "@/lib/parse-question-text";
import { parseCodingProblemText } from "@/lib/parse-coding-problem";
import { COMPOSITE_ASPECT } from "@/lib/course-visual-style";
import {
  backgroundFromPreset,
  type ComposeBackgroundPreset,
} from "@/lib/compose-background";
import type { SceneBackground } from "@/lib/scene-background";
import { templateCountdownDurationMs, renderTemplatePreviewDataUrl } from "@/lib/template-scene-canvas";
import {
  FIXED_TEMPLATE_FONT_SIZE,
  FIXED_TEMPLATE_TEXT_COLOR,
} from "@/lib/template-fixed-presets";

export const Route = createFileRoute("/_authenticated/compose")({
  validateSearch: (s: Record<string, unknown>): { project?: string; part?: string } => ({
    project: typeof s.project === "string" ? s.project : undefined,
    part: typeof s.part === "string" ? s.part : undefined,
  }),
  head: () => ({ meta: [{ title: "Compose Scene — Explainer Studio" }] }),
  component: ComposePage,
});

function ComposePage() {
  const { project: projectId, part: partFromSearch } = Route.useSearch();
  const qc = useQueryClient();

  const runImage = useServerFn(generateComposeImage);
  const runSegment = useServerFn(segmentImageLayers);
  const runFetchMask = useServerFn(fetchImageAsDataUrl);
  const session = getStoredSession();
  const isAdmin = session?.user.isAdmin ?? false;
  const myUserId = session?.user.id ?? null;
  const myEmail = session?.user.email?.trim().toLowerCase() ?? null;

  const { data: project, isLoading: projectLoading, error: projectError } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const timeoutMs = 25_000;
      const result = await Promise.race([
        apiGetProject(projectId!),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Episode load timed out. Try opening from Compose again.")), timeoutMs),
        ),
      ]);
      return result;
    },
    enabled: !!projectId,
    retry: 1,
    staleTime: 10_000,
  });

  const accessibleParts = useMemo(() => {
    const parts = getProjectParts(project);
    if (isAdmin) return parts;
    return parts.filter((part) => {
      if (myUserId && part.assignedUserId === myUserId) return true;
      if (myEmail && part.assignedUserEmail?.trim().toLowerCase() === myEmail) return true;
      return false;
    });
  }, [project, isAdmin, myUserId, myEmail]);

  const [draft, setDraft] = useState<ComposeDraft>(emptyComposeDraft);
  const [codeDraft, setCodeDraft] = useState<ComposeCodeDraft>(emptyComposeCodeDraft);
  const [questionDraft, setQuestionDraft] = useState<ComposeQuestionDraft>(
    emptyComposeQuestionDraft(),
  );
  const [templateDraft, setTemplateDraft] = useState<ComposeTemplateDraft>(
    emptyComposeTemplateDraft(),
  );
  const [recordingDraft, setRecordingDraft] = useState<ComposeRecordingDraft>(
    emptyComposeRecordingDraft(),
  );
  const [questionPaste, setQuestionPaste] = useState("");
  const [parsingQuestion, setParsingQuestion] = useState(false);
  const [generatingMarkTts, setGeneratingMarkTts] = useState(false);
  const [generatingIntroTts, setGeneratingIntroTts] = useState(false);
  const [markDefaultLoaded, setMarkDefaultLoaded] = useState(false);
  const [introDefaultLoaded, setIntroDefaultLoaded] = useState(false);
  const [selectedCropId, setSelectedCropId] = useState<string | null>(null);
  const [annotateCropId, setAnnotateCropId] = useState<string | null>(null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [segmentingLayers, setSegmentingLayers] = useState(false);
  const [generatingTts, setGeneratingTts] = useState(false);
  const [extractingClipAudio, setExtractingClipAudio] = useState(false);
  const [processingRecording2, setProcessingRecording2] = useState(false);
  const [recording2PhraseBusyIndex, setRecording2PhraseBusyIndex] = useState<number | null>(
    null,
  );
  const [recording2Voice, setRecording2Voice] = useState<"am_michael" | "af_heart">(
    "am_michael",
  );
  const [preparingCodeTyping, setPreparingCodeTyping] = useState(false);
  const [loadingFixedPresetId, setLoadingFixedPresetId] = useState<FixedTemplatePresetId | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [openSteps, setOpenSteps] = useState<string[]>(["script"]);
  const [lastImagePrompt, setLastImagePrompt] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<ComposeSourceMode>("script");
  const [useDirectImagePrompt, setUseDirectImagePrompt] = useState(true);
  const [directImagePrompt, setDirectImagePrompt] = useState("");
  const [uploadDataUrl, setUploadDataUrl] = useState<string | null>(null);
  const [partTitle, setPartTitle] = useState("Part 1");
  const [partScriptPlan, setPartScriptPlan] = useState<PartScriptPlan>(() =>
    emptyPartScriptPlan(),
  );
  const [savingPartScript, setSavingPartScript] = useState(false);
  const [partScriptSaveStatus, setPartScriptSaveStatus] = useState<
    "idle" | "pending" | "saving" | "saved" | "error"
  >("idle");
  const lastSavedScriptKeyRef = useRef<string>("");
  const scriptAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scriptAutosaveSeqRef = useRef(0);
  const lastComposeAutosaveKeyRef = useRef<string>("");
  const composeAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [composeAutosaveStatus, setComposeAutosaveStatus] = useState<
    "idle" | "pending" | "saving" | "saved" | "error"
  >("idle");
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [stitchActive, setStitchActive] = useState(false);
  const [backgroundPreset, setBackgroundPreset] =
    useState<ComposeBackgroundPreset>("video-loop");
  const sceneBackground: SceneBackground = useMemo(
    () => backgroundFromPreset(backgroundPreset),
    [backgroundPreset],
  );

  /** Prefer URL part, then explicit selection, then the only assigned part. */
  const activePartId = useMemo(() => {
    if (partFromSearch && accessibleParts.some((p) => p.id === partFromSearch)) {
      return partFromSearch;
    }
    if (selectedPartId && accessibleParts.some((p) => p.id === selectedPartId)) {
      return selectedPartId;
    }
    if (!isAdmin && accessibleParts.length === 1) return accessibleParts[0]!.id;
    return selectedPartId;
  }, [partFromSearch, selectedPartId, accessibleParts, isAdmin]);

  const activeComposeScenes = useMemo((): Scene[] => {
    if (!project) return [];
    const parts = getProjectParts(project);
    const part = activePartId ? parts.find((p) => p.id === activePartId) : undefined;
    return (part?.scenes as Scene[] | undefined)?.slice() ?? [];
  }, [project, activePartId]);

  const scriptSceneCompletions = useMemo(
    () => partSceneCompletionList(partScriptPlan, activeComposeScenes),
    [partScriptPlan, activeComposeScenes],
  );

  /** Always read latest parts from SQLite before mutating — avoids lost scenes on rapid saves. */
  async function loadFreshProjectParts(): Promise<{
    record: NonNullable<typeof project>;
    parts: ReturnType<typeof getProjectParts>;
    scenes: Scene[];
  }> {
    if (!projectId) throw new Error("Missing project.");
    const record = await apiGetProject(projectId);
    const parts = getProjectParts(record);
    const part = activePartId ? parts.find((p) => p.id === activePartId) : undefined;
    const scenes = (part?.scenes ?? []).map(stripSceneStitchMetadata);
    return { record: record as NonNullable<typeof project>, parts, scenes };
  }

  // Keep selectedPartId locked to the part the collaborator is allowed to edit.
  useEffect(() => {
    if (!activePartId) return;
    if (selectedPartId === activePartId) return;
    setSelectedPartId(activePartId);
  }, [activePartId, selectedPartId]);

  /** Restore in-progress compose work after refresh (session tab only). */
  const [hydratedProjectId, setHydratedProjectId] = useState<string | null>(null);
  useEffect(() => {
    setHydratedProjectId(null);
    if (!projectId) return;
    const saved = readComposeWorkingDraft(projectId);
    if (saved && composeWorkingDraftHasContent(saved)) {
      setSourceMode(saved.sourceMode);
      setDraft(saved.draft);
      setCodeDraft(saved.codeDraft);
      setQuestionDraft(saved.questionDraft);
      setTemplateDraft(saved.templateDraft);
      setRecordingDraft(saved.recordingDraft);
      setQuestionPaste(saved.questionPaste ?? "");
      setOpenSteps(saved.openSteps?.length ? saved.openSteps : ["script"]);
      setPartTitle(saved.partTitle || "Part 1");
      {
        const restored = saved.partScriptPlan
          ? {
              scenes: saved.partScriptPlan.scenes
                .map((s) => normalizePartScriptScene(s))
                .filter((s): s is PartScriptScene => s != null),
            }
          : saved.partScript?.trim()
            ? partScriptPlanFromPart({ script: saved.partScript })
            : emptyPartScriptPlan();
        // Only restore script draft when it has real narration/code — not empty placeholders.
        const hasRealScript = restored.scenes.some(
          (s) =>
            !!(
              s.script.trim() ||
              s.scriptAfter?.trim() ||
              s.code?.trim() ||
              s.screen?.trim() ||
              s.expectedOutput?.trim() ||
              s.imagePrompt?.trim() ||
              s.practiceBrief?.trim() ||
              s.question?.question.trim()
            ),
        );
        if (hasRealScript) {
          setPartScriptPlan(restored);
        }
      }
      // Prefer the deep-linked / assigned part over any stale session selection.
      setSelectedPartId(partFromSearch ?? saved.selectedPartId);
      setEditingSceneId(saved.editingSceneId);
      setBackgroundPreset(saved.backgroundPreset ?? "video-loop");
      setUseDirectImagePrompt(saved.useDirectImagePrompt !== false);
      setDirectImagePrompt(saved.directImagePrompt ?? "");
      setUploadDataUrl(saved.uploadDataUrl);
      setLastImagePrompt(saved.lastImagePrompt);
      setShowPreview(!!saved.showPreview);
    }
    setHydratedProjectId(projectId);
  }, [projectId, partFromSearch]);

  /** Persist working draft until New scene / save / tab close. */
  useEffect(() => {
    if (!projectId || hydratedProjectId !== projectId) return;
    const handle = window.setTimeout(() => {
      const payload = {
        sourceMode,
        draft,
        codeDraft,
        questionDraft,
        templateDraft,
        recordingDraft,
        questionPaste,
        partScriptPlan,
        openSteps,
        partTitle,
        selectedPartId,
        editingSceneId,
        backgroundPreset,
        useDirectImagePrompt,
        directImagePrompt,
        uploadDataUrl,
        lastImagePrompt,
        showPreview,
      };
      if (composeWorkingDraftHasContent({ ...payload, updatedAt: 0 })) {
        writeComposeWorkingDraft(projectId, payload);
      } else {
        clearComposeWorkingDraft(projectId);
      }
    }, 400);
    return () => window.clearTimeout(handle);
  }, [
    projectId,
    hydratedProjectId,
    sourceMode,
    draft,
    codeDraft,
    questionDraft,
    templateDraft,
    recordingDraft,
    questionPaste,
    partScriptPlan,
    openSteps,
    partTitle,
    selectedPartId,
    editingSceneId,
    backgroundPreset,
    useDirectImagePrompt,
    directImagePrompt,
    uploadDataUrl,
    lastImagePrompt,
    showPreview,
  ]);

  useEffect(() => {
    if (!projectId || !project || partTitle.trim() || selectedPartId) return;
    const scenes = (project.scenes as unknown[]) ?? [];
    if (scenes.length > 0) {
      setPartTitle(defaultPartTitle(getProjectParts(project)));
    }
  }, [projectId, project, partTitle, selectedPartId]);

  const previewScene = useMemo(() => {
    if (sourceMode === "script") return null;
    if (sourceMode === "code") return composeCodeDraftToScene(codeDraft);
    if (sourceMode === "question") return composeQuestionDraftToScene(questionDraft);
    if (sourceMode === "template") {
      if (templateDraft.templateKind === "codeTyping") {
        return composeCodeDraftToScene(codeDraft);
      }
      return composeTemplateDraftToScene(templateDraft);
    }
    if (isRecordingLikeMode(sourceMode)) {
      return composeRecordingDraftToScene(recordingDraft);
    }
    return composeDraftToScene(draft);
  }, [sourceMode, codeDraft, questionDraft, templateDraft, recordingDraft, draft]);

  const imageStatus = useMemo(
    () => ({
      image: !!draft.compositeUrl,
      tts: !!draft.audioUrl,
      crop: draft.crops.length > 0,
      timeline: draft.placements.length > 0,
      preview: showPreview,
      saveReady:
        !!draft.compositeUrl &&
        !!draft.audioUrl &&
        draft.crops.length > 0 &&
        draft.placements.length > 0,
    }),
    [draft, showPreview],
  );

  const templateStatus = useMemo(() => {
    const isFixed = templateDraft.mode === "fixed";
    if (templateDraft.templateKind === "codeTyping") {
      const beats = codeDraft.codeTypingBeats ?? [];
      const setup =
        templateDraft.picked &&
        beats.some((b) => b.code.trim().length >= 1) &&
        beats.some((b) => b.output.trim().length >= 1);
      const timed = codeDraft.ready && !!codeDraft.audioUrl && codeDraft.durationMs > 0;
      return {
        setup,
        tts: timed,
        preview: showPreview,
        saveReady: setup && timed,
      };
    }
    const setup =
      templateDraft.picked &&
      (isFixed ||
        (templateDraft.templateKind === "countdown"
          ? templateDraft.countdownSec >= 1
          : templateDraft.text.trim().length >= 1));
    return {
      setup,
      tts: isFixed ? !!templateDraft.audioUrl : templateDraft.ready && !!templateDraft.audioUrl,
      preview: showPreview,
      saveReady: isFixed
        ? setup && !!templateDraft.audioUrl
        : setup && templateDraft.ready && !!templateDraft.audioUrl,
    };
  }, [templateDraft, codeDraft, showPreview]);

  const codeStatus = useMemo(
    () => {
      const beats = codeDraft.codeTypingBeats ?? [];
      const typingSetup =
        codeDraft.codeVariant === "typing"
          ? beats.some((b) => b.code.trim().length >= 1) || codeDraft.code.trim().length >= 3
          : codeDraft.code.trim().length >= 3;
      return {
        setup: typingSetup,
        tts: codeDraft.ready && !!codeDraft.audioUrl,
        preview: showPreview,
        saveReady: codeDraft.ready && !!codeDraft.audioUrl,
      };
    },
    [codeDraft, showPreview],
  );

  const recordingStatus = useMemo(
    () => ({
      setup: !!recordingDraft.mediaUrl && recordingDraft.sourceDurationMs > 0,
      // A clip with embedded audio is fully audio-ready even when we could not
      // demux a separate audio file on the hosted runtime.
      tts:
        recordingDraft.ready &&
        (!!recordingDraft.audioUrl || recordingDraft.useEmbeddedAudio),
      preview: showPreview,
      saveReady:
        !!recordingDraft.mediaUrl &&
        recordingDraft.ready &&
        (!!recordingDraft.audioUrl || recordingDraft.useEmbeddedAudio) &&
        recordingDraft.sourceDurationMs > 0,
    }),
    [recordingDraft, showPreview],
  );

  const questionStatus = useMemo(() => {
    const isCoding = questionDraft.kind === "coding";
    const isPredict = questionDraft.kind === "predictOutput";
    const optionsOk = isCoding ? true : questionDraft.options.every((o) => o.trim().length > 0);
    const filledTests = questionDraft.codingTestCases.filter(
      (t) => t.input.trim() && t.output.trim(),
    );
    const contentOk = isCoding
      ? questionDraft.codingTitle.trim().length >= 2 &&
        questionDraft.question.trim().length >= 3 &&
        questionDraft.codingStarterCode.trim().length >= 3 &&
        filledTests.length >= 1 &&
        filledTests.length <= 3
      : isPredict
        ? questionDraft.question.trim().length >= 3 &&
          questionDraft.predictCode.trim().length >= 1 &&
          optionsOk
        : questionDraft.question.trim().length >= 3 && optionsOk;
    const markTextOk = questionDraft.markText.trim().length >= 2;
    const introTextOk = questionDraft.introText.trim().length >= 2;
    const markAudioOk =
      !!questionDraft.markAudioUrl &&
      questionDraft.markAudioForText.trim() === questionDraft.markText.trim();
    const introAudioOk =
      !!questionDraft.introAudioUrl &&
      questionDraft.introAudioForText.trim() === questionDraft.introText.trim();
    const setup = contentOk && markTextOk && markAudioOk && introTextOk && introAudioOk;
    return {
      contentOk,
      introAudioOk,
      markAudioOk,
      setup,
      tts: questionDraft.ready && !!questionDraft.audioUrl,
      preview: showPreview,
      saveReady: setup && questionDraft.ready && !!questionDraft.audioUrl,
    };
  }, [questionDraft, showPreview]);

  useEffect(() => {
    if (sourceMode !== "question" || markDefaultLoaded || questionDraft.markAudioUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res =
          questionDraft.kind === "coding"
            ? await apiEnsureCodingMarkDefaultTts()
            : await apiEnsureMarkDefaultTts();
        if (cancelled) return;
        setQuestionDraft((d) => ({
          ...d,
          markText: d.markText.trim() || res.text,
          markAudioUrl: d.markAudioUrl ?? res.audioUrl,
          markAudioForText: d.markAudioForText || res.text,
        }));
        setMarkDefaultLoaded(true);
        void probeAudioDurationMs(res.audioUrl).then((ms) => {
          if (cancelled || ms == null) return;
          setQuestionDraft((d) =>
            d.markAudioUrl === res.audioUrl || !d.markAudioUrl
              ? { ...d, markDurationMs: ms }
              : d,
          );
        });
      } catch (err) {
        if (!cancelled) {
          setMarkDefaultLoaded(true);
          toast.error(
            `Default narration failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceMode, markDefaultLoaded, questionDraft.markAudioUrl, questionDraft.kind]);

  useEffect(() => {
    if (sourceMode !== "question" || introDefaultLoaded || questionDraft.introAudioUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res =
          questionDraft.kind === "coding"
            ? await apiEnsureCodingIntroDefaultTts()
            : await apiEnsureIntroDefaultTts();
        if (cancelled) return;
        const probed = await probeAudioDurationMs(res.audioUrl);
        setQuestionDraft((d) => ({
          ...d,
          introText: d.introText.trim() || res.text,
          introAudioUrl: d.introAudioUrl ?? res.audioUrl,
          introAudioForText: d.introAudioForText || res.text,
          introDurationMs: probed ?? d.introDurationMs,
        }));
        setIntroDefaultLoaded(true);
      } catch {
        if (!cancelled) setIntroDefaultLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceMode, introDefaultLoaded, questionDraft.introAudioUrl, questionDraft.kind]);

  const canSaveScene = !!projectId && !!partTitle.trim();

  const composeSceneSaveReady = useMemo(() => {
    if (!canSaveScene || sourceMode === "script") return false;
    if (extractingClipAudio || processingRecording2) return false;
    if (sourceMode === "upload") return imageStatus.saveReady;
    if (sourceMode === "template") return templateStatus.saveReady;
    if (sourceMode === "code") return codeStatus.saveReady;
    if (sourceMode === "question") return questionStatus.saveReady;
    if (isRecordingLikeMode(sourceMode)) return recordingStatus.saveReady;
    return false;
  }, [
    canSaveScene,
    sourceMode,
    extractingClipAudio,
    processingRecording2,
    imageStatus.saveReady,
    templateStatus.saveReady,
    codeStatus.saveReady,
    questionStatus.saveReady,
    recordingStatus.saveReady,
  ]);

  const composeAutosaveKey = useMemo(() => {
    if (!composeSceneSaveReady || !previewScene) return "";
    return [
      editingSceneId ?? "new",
      sourceMode,
      previewScene.kind ?? "",
      previewScene.audioUrl ?? "",
      previewScene.mediaUrl ?? "",
      previewScene.backgroundUrl ?? "",
      (previewScene.narrationText ?? "").slice(0, 120),
      String(previewScene.elements?.length ?? 0),
      String(previewScene.durationMs ?? 0),
    ].join("|");
  }, [composeSceneSaveReady, previewScene, editingSceneId, sourceMode]);

  function countdownNarrationText(text: string, countdownSec: number): string {
    const cleaned = text.trim().replace(/[.!?…\s]+$/g, "");
    const numbers = Array.from(
      { length: Math.max(1, Math.round(countdownSec || 1)) },
      (_, i) => String(Math.max(1, Math.round(countdownSec || 1)) - i),
    ).join(". ");
    return cleaned ? `${cleaned}. ${numbers}.` : `${numbers}.`;
  }

  function switchSourceMode(mode: ComposeSourceMode) {
    setSourceMode(mode);
    setDraft(emptyComposeDraft());
    setCodeDraft(emptyComposeCodeDraft());
    setQuestionDraft(emptyComposeQuestionDraft());
    setTemplateDraft(emptyComposeTemplateDraft());
    setRecordingDraft(
      emptyComposeRecordingDraft({
        useEmbeddedAudio: mode === "clip",
        voiceReplace: mode === "recording2",
      }),
    );
    setQuestionPaste("");
    setSelectedCropId(null);
    setShowPreview(false);
    setError(null);
    setLastImagePrompt(null);
    setUploadDataUrl(null);
    setExtractingClipAudio(false);
    setProcessingRecording2(false);
    setOpenSteps(
      mode === "script"
        ? ["script"]
        : mode === "code" ||
            mode === "question" ||
            mode === "template" ||
            isRecordingLikeMode(mode)
          ? ["setup"]
          : ["image"],
    );
  }

  function handleQuestionKind(kind: QuestionKind) {
    setQuestionDraft((d) => {
      const fresh = emptyComposeQuestionDraft(kind);
      const switchingCoding = (kind === "coding") !== (d.kind === "coding");
      const keepOptions = kind !== "coding";
      return {
        ...fresh,
        script: d.script,
        question: d.question,
        subtitle: switchingCoding ? fresh.subtitle : d.subtitle || fresh.subtitle,
        options: keepOptions ? d.options : fresh.options,
        correctInput: keepOptions ? d.correctInput : "",
        codingTitle: kind === "coding" ? d.codingTitle || fresh.codingTitle : fresh.codingTitle,
        codingStarterCode:
          kind === "coding" ? d.codingStarterCode : fresh.codingStarterCode,
        codingPaste: kind === "coding" ? d.codingPaste : fresh.codingPaste,
        codingTestCases: kind === "coding" ? d.codingTestCases : fresh.codingTestCases,
        predictCode: kind === "predictOutput" ? d.predictCode || fresh.predictCode : fresh.predictCode,
        predictSelectMode:
          kind === "predictOutput"
            ? d.predictSelectMode || fresh.predictSelectMode
            : fresh.predictSelectMode,
        markText: switchingCoding ? fresh.markText : d.markText,
        markGapSec: d.markGapSec,
        markCountdownSec: d.markCountdownSec,
        markAudioUrl: switchingCoding ? null : d.markAudioUrl,
        markAudioForText: switchingCoding ? "" : d.markAudioForText,
        markDurationMs: switchingCoding ? 0 : d.markDurationMs,
        introText: switchingCoding ? fresh.introText : d.introText,
        introGapSec: d.introGapSec,
        introAudioUrl: switchingCoding ? null : d.introAudioUrl,
        introAudioForText: switchingCoding ? "" : d.introAudioForText,
        introDurationMs: switchingCoding ? 0 : d.introDurationMs,
        audioUrl: null,
        durationMs: 0,
        ready: false,
      };
    });
    if ((kind === "coding") !== (questionDraft.kind === "coding")) {
      setMarkDefaultLoaded(false);
      setIntroDefaultLoaded(false);
    }
  }

  async function handleUseDefaultIntroTts() {
    setError(null);
    setGeneratingIntroTts(true);
    setShowPreview(false);
    try {
      const isCoding = questionDraft.kind === "coding";
      const res = isCoding
        ? await apiEnsureCodingIntroDefaultTts()
        : await apiEnsureIntroDefaultTts();
      const probed = await probeAudioDurationMs(res.audioUrl);
      setQuestionDraft((d) => ({
        ...d,
        introText: res.text,
        introAudioUrl: res.audioUrl,
        introAudioForText: res.text,
        introDurationMs: probed ?? d.introDurationMs,
        ready: false,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingIntroTts(false);
    }
  }

  async function handleGenerateIntroTts() {
    const text = questionDraft.introText.trim();
    if (text.length < 2) {
      setError("Enter intro screen text first.");
      return;
    }
    setError(null);
    setGeneratingIntroTts(true);
    setShowPreview(false);
    try {
      const res =
        questionDraft.kind === "coding"
          ? await apiGenerateCodingIntroTts(text)
          : await apiGenerateIntroTts(text);
      const probed = await probeAudioDurationMs(res.audioUrl);
      setQuestionDraft((d) => ({
        ...d,
        introText: res.text,
        introAudioUrl: res.audioUrl,
        introAudioForText: res.text,
        introDurationMs: probed ?? d.introDurationMs,
        ready: false,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingIntroTts(false);
    }
  }

  function applyParsedQuestion(parsed: ParsedQuestion) {
    setQuestionDraft((d) => ({
      ...d,
      kind: parsed.kind === "predictOutput" ? "predictOutput" : parsed.kind,
      question: parsed.question,
      options: parsed.options,
      predictCode:
        parsed.kind === "predictOutput"
          ? parsed.predictCode ?? d.predictCode
          : d.predictCode,
      predictSelectMode:
        parsed.kind === "predictOutput"
          ? parsed.predictSelectMode ?? d.predictSelectMode
          : d.predictSelectMode,
      ready: false,
    }));
  }

  async function handleUseDefaultMarkTts() {
    setError(null);
    setGeneratingMarkTts(true);
    try {
      const isCoding = questionDraft.kind === "coding";
      const res = isCoding
        ? await apiEnsureCodingMarkDefaultTts()
        : await apiEnsureMarkDefaultTts();
      const probed = await probeAudioDurationMs(res.audioUrl);
      setQuestionDraft((d) => ({
        ...d,
        markText: res.text,
        markGapSec: 2,
        markCountdownSec: 3,
        markAudioUrl: res.audioUrl,
        markAudioForText: res.text,
        markDurationMs: probed ?? d.markDurationMs,
        ready: false,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingMarkTts(false);
    }
  }

  async function handleGenerateMarkTts() {
    const text = questionDraft.markText.trim();
    if (text.length < 2) {
      setError("Enter countdown page text first.");
      return;
    }
    setError(null);
    setGeneratingMarkTts(true);
    setShowPreview(false);
    try {
      const res =
        questionDraft.kind === "coding"
          ? await apiGenerateCodingMarkTts(text)
          : await apiGenerateMarkTts(text);
      const probed = await probeAudioDurationMs(res.audioUrl);
      setQuestionDraft((d) => ({
        ...d,
        markText: res.text,
        markAudioUrl: res.audioUrl,
        markAudioForText: res.text,
        markDurationMs: probed ?? d.markDurationMs,
        ready: false,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingMarkTts(false);
    }
  }

  async function handleParseQuestion() {
    if (questionDraft.kind === "coding") return;
    const raw = questionPaste.trim();
    if (raw.length < 10) {
      setError("Paste a question with options A–D first.");
      return;
    }
    setError(null);
    setParsingQuestion(true);
    setShowPreview(false);
    try {
      if (questionDraft.kind === "predictOutput") {
        const local = parseQuestionTextFallback(raw, "predictOutput");
        if (local?.predictCode) {
          applyParsedQuestion({
            ...local,
            kind: "predictOutput",
            predictSelectMode:
              local.predictSelectMode ?? questionDraft.predictSelectMode,
          });
          return;
        }
        setError(
          "Could not parse. Include a question, a ``` code ``` block, and options A–D.",
        );
        return;
      }
      const kindHint = questionDraft.kind === "msq" ? "msq" : "mcq";
      const local = parseQuestionTextFallback(raw, kindHint);
      if (local) {
        applyParsedQuestion(local);
        return;
      }
      const parsed = await apiParseQuestion(raw, kindHint);
      applyParsedQuestion(parsed);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setParsingQuestion(false);
    }
  }

  async function handleQuestionTts() {
    if (!questionStatus.contentOk) {
      setError(
        questionDraft.kind === "coding"
          ? "Fill from the template first (title, instruction, starter code, and at least one test case with Input + Output)."
          : questionDraft.kind === "predictOutput"
            ? "Fill in the question, code block, and all four options first."
            : "Fill in the question and all four options first.",
      );
      return;
    }
    const q = questionDraft;
    const script =
      q.script.trim() ||
      buildQuestionNarration({
        kind: q.kind,
        question: q.question.trim(),
        subtitle:
          q.subtitle.trim() ||
          (q.kind === "coding"
            ? "Coding Problem"
            : q.kind === "predictOutput"
              ? "Predict output"
              : "Question"),
        options: q.options,
        correct: parseCorrectLetters(q.correctInput, q.kind, q.predictSelectMode),
        codingTitle: q.codingTitle,
        codingStarterCode: q.codingStarterCode,
        codingTestCases: q.codingTestCases,
        predictCode: q.predictCode,
        predictSelectMode: q.predictSelectMode,
      });

    setError(null);
    setGeneratingTts(true);
    setShowPreview(false);
    try {
      const tts = await apiGenerateTts(script);
      const durationMs = (await probeAudioDurationMs(tts.audioUrl)) ?? 8000;
      const title =
        q.title.trim() ||
        (q.kind === "coding"
          ? q.codingTitle.trim() || q.question.trim().slice(0, 48)
          : q.question.trim().slice(0, 48)) ||
        "Question";
      setQuestionDraft((d) => ({
        ...d,
        script,
        title,
        audioUrl: tts.audioUrl,
        durationMs,
        ready: true,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingTts(false);
    }
  }

  async function handleUploadChange(url: string | null) {
    setUploadDataUrl(url);
    setShowPreview(false);
    if (!url) {
      setDraft((d) => ({
        ...d,
        compositeUrl: null,
        crops: [],
        placements: [],
      }));
      return;
    }
    try {
      const imgEl = await loadImage(url);
      const bgAspect = (imgEl.naturalWidth || 1536) / (imgEl.naturalHeight || 1024);
      setDraft((d) => ({
        ...d,
        compositeUrl: url,
        bgAspect,
        crops: [],
        placements: [],
      }));
    } catch {
      setError("Could not load uploaded image.");
    }
  }

  async function handleGenerateImage() {
    const script = draft.script.trim();
    const directPrompt = useDirectImagePrompt ? directImagePrompt.trim() : "";

    if (useDirectImagePrompt) {
      if (directPrompt.length < 10) {
        setError("Enter a custom image prompt (at least 10 characters).");
        return;
      }
    } else if (script.length < 3) {
      setError("Enter a script (at least a few words), or use custom image prompt mode.");
      return;
    }

    setError(null);
    setGeneratingImage(true);
    setShowPreview(false);
    setLastImagePrompt(null);
    try {
      // Style references are applied server-side from the house style — the
      // client neither picks nor uploads them.
      const img = await runImage({
        data: {
          script: script || undefined,
          ...(directPrompt ? { imagePrompt: directPrompt } : {}),
          model: IMAGE_MODEL,
          aspectRatio: IMAGE_ASPECT,
        },
      });

      const imgEl = await loadImage(img.imageUrl);
      const bgAspect = (imgEl.naturalWidth || 1536) / (imgEl.naturalHeight || 1024);

      setDraft((d) => ({
        ...d,
        script,
        title: img.title,
        compositeUrl: img.imageUrl,
        bgAspect,
        crops: [],
        placements: [],
      }));
      setLastImagePrompt(img.imagePrompt ?? null);
      setSelectedCropId(null);
      setGeneratingImage(false);

      // Layers stay manual: crop elements by dragging on the image, or run
      // SAM 2 explicitly from the "Auto-detect layers" button.
      setOpenSteps((s) => (s.includes("crop") ? s : [...s, "crop"]));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setGeneratingImage(false);
    }
  }

  /** Explicit SAM 2 pass — only runs when the user asks for it. */
  async function handleAutoLayers() {
    const composite = draft.compositeUrl;
    if (!composite) {
      setError("Complete the image step first.");
      return;
    }
    setError(null);
    setSegmentingLayers(true);
    try {
      const { crops, warning } = await autoLayersFromComposite(composite, {
        segment: runSegment,
        fetchMask: runFetchMask,
      });
      setDraft((d) => ({ ...d, crops, placements: [] }));
      if (crops.length > 0) setSelectedCropId(crops[0]!.id);
      if (warning) setError(warning);
    } catch (segErr: unknown) {
      setError(segErr instanceof Error ? `Layering failed: ${segErr.message}` : "Layering failed.");
    } finally {
      setSegmentingLayers(false);
    }
  }

  async function handleGenerateTts() {
    const script = draft.script.trim();
    if (!draft.compositeUrl) {
      setError("Complete the image step first.");
      return;
    }
    if (script.length < 3) {
      setError("Enter narration text for TTS (at least a few words).");
      return;
    }

    setError(null);
    setGeneratingTts(true);
    setShowPreview(false);
    try {
      const tts = await apiGenerateTts(script);
      const durationMs = (await probeAudioDurationMs(tts.audioUrl)) ?? 8000;
      const title =
        draft.title ??
        (script
          .split(/[.!?]/)
          .at(0)
          ?.trim()
          .split(/\s+/)
          .slice(0, 6)
          .join(" ") || "Scene");

      setDraft((d) => ({
        ...d,
        script,
        title,
        audioUrl: tts.audioUrl,
        durationMs,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingTts(false);
    }
  }

  /**
   * Narration audio uploaded instead of generated. Mirrors the TTS handlers:
   * the scene still needs a real durationMs or the reveal schedule collapses.
   */
  async function handleUploadNarration(dataUrl: string | null) {
    if (!dataUrl) {
      setDraft((d) => ({ ...d, audioUrl: null, durationMs: 0 }));
      return;
    }
    setError(null);
    try {
      const durationMs = await probeAudioDurationMs(dataUrl);
      if (!durationMs) throw new Error("Could not read the length of that audio file.");
      setDraft((d) => ({
        ...d,
        title: d.title ?? "Scene",
        audioUrl: dataUrl,
        durationMs,
      }));
      setShowPreview(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCodeUploadNarration(dataUrl: string | null) {
    if (!dataUrl) {
      setCodeDraft((d) => ({ ...d, audioUrl: null, durationMs: 0, ready: false }));
      return;
    }
    setError(null);
    try {
      const durationMs = await probeAudioDurationMs(dataUrl);
      if (!durationMs) throw new Error("Could not read the length of that audio file.");
      setCodeDraft((d) => ({ ...d, audioUrl: dataUrl, durationMs, ready: true }));
      setShowPreview(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleQuestionUploadNarration(dataUrl: string | null) {
    if (!dataUrl) {
      setQuestionDraft((d) => ({ ...d, audioUrl: null, durationMs: 0, ready: false }));
      return;
    }
    setError(null);
    try {
      const durationMs = await probeAudioDurationMs(dataUrl);
      if (!durationMs) throw new Error("Could not read the length of that audio file.");
      setQuestionDraft((d) => ({ ...d, audioUrl: dataUrl, durationMs, ready: true }));
      setShowPreview(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleTemplateUploadNarration(dataUrl: string | null) {
    if (!dataUrl) {
      setTemplateDraft((d) => ({ ...d, audioUrl: null, durationMs: 0, ready: false }));
      return;
    }
    setError(null);
    try {
      const durationMs = await probeAudioDurationMs(dataUrl);
      if (!durationMs) throw new Error("Could not read the length of that audio file.");
      setTemplateDraft((d) => ({ ...d, audioUrl: dataUrl, durationMs, ready: true }));
      setShowPreview(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleAddFixedTemplateScene(presetId: FixedTemplatePresetId) {
    if (!projectId || !project) {
      setError("Create a project and name your part first.");
      return;
    }
    if (!partTitle.trim()) {
      setError("Name your part at the top before saving scenes.");
      return;
    }
    setError(null);
    setLoadingFixedPresetId(presetId);
    try {
      const res = await apiEnsureFixedTemplateTts(presetId);
      const durationMs = (await probeAudioDurationMs(res.audioUrl)) ?? 3000;
      const previewUrl = await renderTemplatePreviewDataUrl({
        type: "text",
        text: res.text,
        color: FIXED_TEMPLATE_TEXT_COLOR,
        fontSize: FIXED_TEMPLATE_FONT_SIZE,
      });
      const draft = fixedTemplateDraftFromPreset(presetId, res.audioUrl, durationMs, previewUrl);
      const built = composeTemplateDraftToScene(draft);
      if (!built) throw new Error("Could not build template scene.");
      const scene = await persistSceneAssetsForSave(built, projectId, (input) =>
        apiPersistAsset(input),
      );

      if (!activePartId) {
        throw new Error("Open your assigned part from the episode page before saving scenes.");
      }
      const fresh = await loadFreshProjectParts();
      const nextScenes = [...fresh.scenes, scene];
      const now = new Date().toISOString();
      const nextPlan = mergeScriptPlanWithComposeScenes(partScriptPlan, nextScenes);
      const nextParts = fresh.parts.map((p) =>
        p.id === activePartId
          ? {
              ...p,
              scenes: nextScenes,
              scriptScenes: nextPlan.scenes,
              script: partScriptPlanToText(nextPlan),
              updated_at: now,
            }
          : p,
      );

      await apiSaveProject({
        id: projectId,
        title: fresh.record.title,
        script: partScriptPlanToText(nextPlan) || fresh.record.script || draft.script,
        audio_mode: "tts",
        scenes: nextScenes,
        parts: nextParts,
        thumbnail_url: scene.backgroundUrl ?? previewUrl ?? fresh.record.thumbnail_url ?? undefined,
      });

      rememberLastProject(projectId);
      setSelectedPartId(activePartId);
      setPartScriptPlan(nextPlan);
      lastSavedScriptKeyRef.current = JSON.stringify(nextPlan.scenes);
      setPartScriptSaveStatus("saved");
      qc.setQueryData(["project", projectId], (prev: unknown) => {
        if (!prev || typeof prev !== "object") return prev;
        return {
          ...(prev as Record<string, unknown>),
          scenes: nextScenes,
          parts: nextParts,
        };
      });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      // Keep current compose form — only clear the fixed-template picker loading state.
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingFixedPresetId(null);
    }
  }

  async function handleTemplateTts() {
    const script = templateDraft.script.trim();
    if (script.length < 3) {
      setError("Enter narration for TTS (at least a few words).");
      return;
    }
    if (templateDraft.templateKind === "text" || templateDraft.templateKind === "typing") {
      if (!templateDraft.text.trim()) {
        setError("Enter the on-screen text first.");
        return;
      }
    }
    setError(null);
    setGeneratingTts(true);
    setShowPreview(false);
    try {
      const ttsText =
        templateDraft.templateKind === "countdown"
          ? countdownNarrationText(script, templateDraft.countdownSec)
          : script;
      const tts = await apiGenerateTts(ttsText);
      const audioMs = (await probeAudioDurationMs(tts.audioUrl)) ?? 8000;
      const durationMs =
        templateDraft.templateKind === "countdown"
          ? templateCountdownDurationMs(templateDraft.countdownSec)
          : audioMs;
      setTemplateDraft((d) => ({
        ...d,
        script: ttsText,
        audioUrl: tts.audioUrl,
        durationMs,
        ready: true,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingTts(false);
    }
  }

  async function handleCodeTts() {
    const script = codeDraft.script.trim();
    const beats = resolveCodeTypingBeats({
      beats: codeDraft.codeTypingBeats,
      code: codeDraft.code,
      output: codeDraft.codeOutput,
      runDelayMs: codeDraft.codeRunDelayMs,
      outputHoldMs: codeDraft.codeOutputHoldMs,
    });
    const code =
      codeDraft.codeVariant === "typing" && beats.length
        ? beatsToFullCode(beats).trim()
        : codeDraft.code.trim();
    if (script.length < 3) {
      setError("Enter narration for TTS (at least a few words).");
      return;
    }
    if (code.length < 3) {
      setError("Enter the code snippet to type on screen.");
      return;
    }

    setError(null);
    setGeneratingTts(true);
    setShowPreview(false);
    try {
      const tts = await apiGenerateTts(script);
      const durationMs = (await probeAudioDurationMs(tts.audioUrl)) ?? 8000;
      const first = beats[0];
      setCodeDraft((d) => ({
        ...d,
        script,
        code,
        codeTypingBeats:
          d.codeVariant === "typing" && beats.length ? beats : d.codeTypingBeats,
        codeOutput: first?.output ?? d.codeOutput,
        codeRunDelayMs: first?.runDelayMs ?? d.codeRunDelayMs,
        codeOutputHoldMs: first?.outputHoldMs ?? d.codeOutputHoldMs,
        typingSpeedCps: d.typingSpeedCps ?? DEFAULT_CODE_TYPING_CPS,
        audioUrl: tts.audioUrl,
        durationMs,
        ready: true,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingTts(false);
    }
  }

  async function handlePrepareCodeTypingSilent() {
    const beats = resolveCodeTypingBeats({
      beats: codeDraft.codeTypingBeats,
      code: codeDraft.code,
      output: codeDraft.codeOutput,
      runDelayMs: codeDraft.codeRunDelayMs,
      outputHoldMs: codeDraft.codeOutputHoldMs,
    });
    const fullCode = beatsToFullCode(beats);
    if (fullCode.trim().length < 3) {
      setError("Enter code in at least one step.");
      return;
    }
    if (!beats.some((b) => b.output.trim())) {
      setError("Enter output for at least one step.");
      return;
    }
    const cps = codeDraft.typingSpeedCps ?? DEFAULT_CODE_TYPING_CPS;
    const suggested = suggestedBeatsDurationMs(beats, cps);
    const requested =
      codeDraft.durationMs > 0 ? codeDraft.durationMs : suggested;
    const durationMs = Math.max(2000, Math.round(requested), Math.round(suggested));

    setError(null);
    setPreparingCodeTyping(true);
    setShowPreview(false);
    try {
      const silent = await createSilentAudioUrl(durationMs);
      const first = beats[0];
      setCodeDraft((d) => ({
        ...d,
        code: fullCode,
        codeLanguage: "py",
        codeVariant: "typing",
        silentNarration: true,
        script: "",
        typingSpeedCps: cps,
        codeTypingBeats: beats,
        codeRunDelayMs: first?.runDelayMs,
        codeOutputHoldMs: first?.outputHoldMs,
        codeOutput: first?.output ?? "",
        audioUrl: silent.url,
        durationMs: silent.durationMs,
        ready: true,
      }));
      setTemplateDraft((d) => ({
        ...d,
        ready: true,
        audioUrl: silent.url,
        durationMs: silent.durationMs,
        script: "",
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparingCodeTyping(false);
    }
  }

  async function handleRecordingTts() {
    const script = recordingDraft.script.trim();
    if (!recordingDraft.mediaUrl) {
      setError("Upload a screen recording first.");
      return;
    }
    if (script.length < 3) {
      setError("Enter narration for TTS (at least a few words).");
      return;
    }

    setError(null);
    setGeneratingTts(true);
    setShowPreview(false);
    try {
      const tts = await apiGenerateTts(script);
      // Safari cannot reliably play large data:audio URLs in the sync timeline.
      const audioUrl = await toPlayableAudioUrl(tts.audioUrl, projectId);
      const durationMs = (await probeAudioDurationMs(audioUrl)) ?? 8000;
      setRecordingDraft((d) => ({
        ...d,
        script,
        audioUrl,
        audioDurationMs: durationMs,
        audioSegments: [singleRecordingAudioSegment(durationMs)],
        ready: true,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingTts(false);
    }
  }

  async function handleRecordingUploadNarration(dataUrl: string | null) {
    if (!dataUrl) {
      setRecordingDraft((d) => ({
        ...d,
        audioUrl: null,
        audioDurationMs: 0,
        audioSegments: [],
        ready: false,
      }));
      return;
    }
    setError(null);
    try {
      const audioUrl = await toPlayableAudioUrl(dataUrl, projectId);
      const durationMs = await probeAudioDurationMs(audioUrl);
      if (!durationMs) throw new Error("Could not read the length of that audio file.");
      setRecordingDraft((d) => ({
        ...d,
        audioUrl,
        audioDurationMs: durationMs,
        audioSegments: [singleRecordingAudioSegment(durationMs)],
        ready: true,
      }));
      setShowPreview(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleClipVideoUploaded(result: {
    url: string;
    durationMs: number;
  }) {
    if (!projectId) {
      setError("Select or create a project first, then upload.");
      return;
    }
    setError(null);
    setExtractingClipAudio(true);
    setShowPreview(false);
    setRecordingDraft((d) => ({
      ...d,
      mediaUrl: result.url,
      sourceDurationMs: result.durationMs,
      trimStartMs: 0,
      trimEndMs: result.durationMs,
      videoOffsetMs: 0,
      videoSegments: [
        {
          id: `vid-${Date.now().toString(36)}`,
          trimStartMs: 0,
          trimEndMs: result.durationMs,
          offsetMs: 0,
          rate: 1,
        },
      ],
      cameraKeyframes: [
        { atMs: 0, scale: 1, focusX: 0.5, focusY: 0.5, easing: "easeInOut" },
      ],
      cameraZoomDurationMs: 500,
      cameraZoomSfx: "none",
      blurRegion: null,
      highlights: [],
      useEmbeddedAudio: true,
      voiceReplace: false,
      audioUrl: null,
      audioDurationMs: 0,
      audioSegments: [],
      ready: false,
    }));
    try {
      const audio = await apiExtractVideoAudio({
        projectId,
        videoUrl: result.url,
        durationMs: result.durationMs,
      });
      setRecordingDraft((d) => ({
        ...d,
        mediaUrl: result.url,
        sourceDurationMs: result.durationMs,
        trimStartMs: 0,
        trimEndMs: result.durationMs,
        useEmbeddedAudio: true,
        voiceReplace: false,
        audioUrl: audio.url,
        audioDurationMs: audio.durationMs,
        audioSegments: [singleRecordingAudioSegment(audio.durationMs)],
        cameraZoomSfx: "none",
        ready: true,
      }));
      setOpenSteps(["setup", "edit", "preview"]);
    } catch (e: unknown) {
      // Audio demux is unavailable on the hosted runtime (no ffmpeg process).
      // The clip stays fully usable with its embedded sound, so this is not
      // an error the user needs to see.
      console.warn("[clip] audio extraction skipped:", e);

      setRecordingDraft((d) => ({
        ...d,
        mediaUrl: result.url,
        sourceDurationMs: result.durationMs,
        trimStartMs: 0,
        trimEndMs: result.durationMs,
        useEmbeddedAudio: true,
        voiceReplace: false,
        audioUrl: null,
        audioDurationMs: 0,
        audioSegments: [],
        ready: true,
      }));
      setOpenSteps(["setup", "edit", "preview"]);
    } finally {

      setExtractingClipAudio(false);
    }
  }

  async function handleRecording2VideoUploaded(result: {
    url: string;
    durationMs: number;
  }) {
    if (!projectId) {
      setError("Select or create a project first, then upload.");
      return;
    }
    setError(null);
    setProcessingRecording2(true);
    setShowPreview(false);
    setRecordingDraft((d) => ({
      ...d,
      mediaUrl: result.url,
      sourceDurationMs: result.durationMs,
      trimStartMs: 0,
      trimEndMs: result.durationMs,
      videoOffsetMs: 0,
      videoSegments: [
        {
          id: `vid-${Date.now().toString(36)}`,
          trimStartMs: 0,
          trimEndMs: result.durationMs,
          offsetMs: 0,
          rate: 1,
        },
      ],
      cameraKeyframes: [
        { atMs: 0, scale: 1, focusX: 0.5, focusY: 0.5, easing: "easeInOut" },
      ],
      cameraZoomDurationMs: 500,
      cameraZoomSfx: "swoosh",
      blurRegion: null,
      highlights: [],
      useEmbeddedAudio: false,
      voiceReplace: true,
      voicePhrases: [],
      script: "",
      audioUrl: null,
      audioDurationMs: 0,
      audioSegments: [],
      ready: false,
    }));
    try {
      const tx = await apiRecording2VoiceReplace({
        projectId,
        videoUrl: result.url,
        mode: "transcribe",
      });
      if (!tx.mediaUrl || !tx.phrases?.length) {
        throw new Error("Transcription returned no chunks.");
      }
      setRecordingDraft((d) => ({
        ...d,
        mediaUrl: tx.mediaUrl!,
        sourceDurationMs: tx.videoDurationMs ?? result.durationMs,
        trimStartMs: 0,
        trimEndMs: tx.videoDurationMs ?? result.durationMs,
        videoOffsetMs: 0,
        videoSegments: [
          {
            id: `vid-${Date.now().toString(36)}`,
            trimStartMs: 0,
            trimEndMs: tx.videoDurationMs ?? result.durationMs,
            offsetMs: 0,
            rate: 1,
          },
        ],
        useEmbeddedAudio: false,
        voiceReplace: true,
        voicePhrases: tx.phrases,
        script: tx.script ?? "",
        audioUrl: null,
        audioDurationMs: 0,
        audioSegments: [],
        cameraKeyframes: [
          { atMs: 0, scale: 1, focusX: 0.5, focusY: 0.5, easing: "easeInOut" },
        ],
        cameraZoomDurationMs: 500,
        cameraZoomSfx: "swoosh",
        blurRegion: null,
        highlights: [],
        ready: false,
      }));
      setOpenSteps(["setup"]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setRecordingDraft((d) => ({
        ...d,
        audioUrl: null,
        audioDurationMs: 0,
        audioSegments: [],
        voicePhrases: [],
        script: "",
        ready: false,
      }));
    } finally {
      setProcessingRecording2(false);
    }
  }

  function applyRecording2AssembleResult(replaced: {
    mediaUrl?: string;
    audioUrl?: string;
    videoDurationMs?: number;
    audioDurationMs?: number;
    script?: string;
    phrases?: NonNullable<ComposeRecordingDraft["voicePhrases"]>;
  }) {
    if (!replaced.mediaUrl || !replaced.audioUrl || !replaced.audioDurationMs) {
      throw new Error("Voice assemble failed");
    }
    const videoDurationMs = replaced.videoDurationMs ?? recordingDraft.sourceDurationMs;
    const audioDurationMs = replaced.audioDurationMs!;
    const timelineMs = Math.max(videoDurationMs, audioDurationMs);
    setRecordingDraft((d) => ({
      ...d,
      mediaUrl: replaced.mediaUrl!,
      sourceDurationMs: Math.max(videoDurationMs, 1),
      trimStartMs: 0,
      trimEndMs: timelineMs,
      videoOffsetMs: 0,
      videoSegments: [
        {
          id: `vid-${Date.now().toString(36)}`,
          trimStartMs: 0,
          trimEndMs: videoDurationMs,
          offsetMs: 0,
          rate: 1,
        },
      ],
      useEmbeddedAudio: false,
      voiceReplace: true,
      voicePhrases: replaced.phrases ?? d.voicePhrases,
      script: replaced.script || d.script,
      audioUrl: replaced.audioUrl!,
      audioDurationMs,
      audioSegments: [singleRecordingAudioSegment(audioDurationMs)],
      ready: true,
    }));
    setOpenSteps(["setup", "edit"]);
  }

  async function handleRecording2GeneratePhrase(phraseIndex: number) {
    if (!projectId) {
      setError("Select or create a project first.");
      return;
    }
    if (!recordingDraft.mediaUrl) {
      setError("Upload a screen recording first.");
      return;
    }
    const phrases = recordingDraft.voicePhrases ?? [];
    if (!phrases[phraseIndex]) {
      setError("Chunk not found.");
      return;
    }
    if (phrases[phraseIndex]!.text.trim().length < 2) {
      setError(`Chunk ${phraseIndex + 1} needs text before generating.`);
      return;
    }
    setError(null);
    setProcessingRecording2(true);
    setRecording2PhraseBusyIndex(phraseIndex);
    setShowPreview(false);
    try {
      const res = await apiRecording2VoiceReplace({
        projectId,
        videoUrl: recordingDraft.mediaUrl,
        mode: "generatePhrase",
        phrases,
        phraseIndex,
        videoDurationMs: recordingDraft.sourceDurationMs,
        voice: recording2Voice,
      });
      if (!res.phrase) throw new Error("Chunk voice generation failed");
      const nextPhrases = phrases.map((p, i) =>
        i === phraseIndex ? { ...res.phrase! } : p,
      );
      setRecordingDraft((d) => ({
        ...d,
        voicePhrases: nextPhrases,
        script: nextPhrases
          .map((p) => p.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
        ready: false,
        audioUrl: null,
        audioDurationMs: 0,
        audioSegments: [],
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProcessingRecording2(false);
      setRecording2PhraseBusyIndex(null);
    }
  }

  async function handleRecording2GenerateAll() {
    if (!projectId) {
      setError("Select or create a project first.");
      return;
    }
    if (!recordingDraft.mediaUrl) {
      setError("Upload a screen recording first.");
      return;
    }
    const phrases = recordingDraft.voicePhrases ?? [];
    if (!phrases.length) {
      setError("No transcript chunks yet — upload a recording first.");
      return;
    }
    if (phrases.some((p) => p.text.trim().length < 2)) {
      setError("Every chunk needs text before generating.");
      return;
    }
    setError(null);
    setProcessingRecording2(true);
    setShowPreview(false);
    try {
      const replaced = await apiRecording2VoiceReplace({
        projectId,
        videoUrl: recordingDraft.mediaUrl,
        mode: "generateAll",
        phrases,
        videoDurationMs: recordingDraft.sourceDurationMs,
        voice: recording2Voice,
      });
      applyRecording2AssembleResult(replaced);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProcessingRecording2(false);
    }
  }

  async function handleRecording2AssembleVoice() {
    if (!projectId) {
      setError("Select or create a project first.");
      return;
    }
    if (!recordingDraft.mediaUrl) {
      setError("Upload a screen recording first.");
      return;
    }
    const phrases = recordingDraft.voicePhrases ?? [];
    if (!phrases.length || phrases.some((p) => !p.audioUrl)) {
      setError("Generate every chunk first, or use Generate all.");
      return;
    }
    setError(null);
    setProcessingRecording2(true);
    setShowPreview(false);
    try {
      const replaced = await apiRecording2VoiceReplace({
        projectId,
        videoUrl: recordingDraft.mediaUrl,
        mode: "assemble",
        phrases,
        videoDurationMs: recordingDraft.sourceDurationMs,
        voice: recording2Voice,
      });
      applyRecording2AssembleResult(replaced);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProcessingRecording2(false);
    }
  }

  async function handleRecording2RegenerateVoice() {
    if ((recordingDraft.voicePhrases?.length ?? 0) > 0) {
      await handleRecording2GenerateAll();
      return;
    }
    if (!projectId) {
      setError("Select or create a project first.");
      return;
    }
    if (!recordingDraft.mediaUrl) {
      setError("Upload a screen recording first.");
      return;
    }
    const script = recordingDraft.script.trim();
    if (script.length < 3) {
      setError("Enter narration text before regenerating voice.");
      return;
    }
    setError(null);
    setProcessingRecording2(true);
    setShowPreview(false);
    try {
      const replaced = await apiRecording2VoiceReplace({
        projectId,
        videoUrl: recordingDraft.mediaUrl,
        mode: "full",
        script,
        voice: recording2Voice,
      });
      applyRecording2AssembleResult(replaced);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProcessingRecording2(false);
    }
  }

  function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function addCrop(crop: ComposeCrop) {
    setDraft((d) => ({ ...d, crops: [...d.crops, crop] }));
  }

  function removeCrop(id: string) {
    setDraft((d) => ({
      ...d,
      crops: d.crops.filter((c) => c.id !== id),
      placements: d.placements.filter((p) => p.cropId !== id),
    }));
    if (selectedCropId === id) setSelectedCropId(null);
    if (annotateCropId === id) setAnnotateCropId(null);
  }

  function updateCropImage(cropId: string, imageUrl: string) {
    setDraft((d) => ({
      ...d,
      crops: d.crops.map((c) => (c.id === cropId ? { ...c, imageUrl } : c)),
    }));
  }

  function addPlacement(cropId: string, startMs: number, sfxUrl?: string | null) {
    const id = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setDraft((d) => ({
      ...d,
      placements: [
        ...d.placements,
        {
          id,
          cropId,
          startMs: Math.max(0, startMs),
          ...(sfxUrl ? { sfxUrl } : {}),
        },
      ],
    }));
  }

  function updatePlacement(
    id: string,
    patch: { startMs?: number; sfxUrl?: string | null },
  ) {
    setDraft((d) => ({
      ...d,
      placements: d.placements.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p };
        if (patch.startMs != null && Number.isFinite(patch.startMs)) {
          next.startMs = Math.max(0, Math.round(patch.startMs));
        }
        if (patch.sfxUrl === null) {
          delete next.sfxUrl;
        } else if (patch.sfxUrl !== undefined) {
          next.sfxUrl = patch.sfxUrl;
        }
        return next;
      }),
    }));
  }

  function resetSceneDraft() {
    setDraft(emptyComposeDraft());
    setSelectedCropId(null);
    setShowPreview(false);
    setError(null);
    setLastImagePrompt(null);
    setUseDirectImagePrompt(true);
    setDirectImagePrompt("");
    setUploadDataUrl(null);
    setCodeDraft(emptyComposeCodeDraft());
    setQuestionDraft(emptyComposeQuestionDraft());
    setTemplateDraft(emptyComposeTemplateDraft());
    setRecordingDraft(
      emptyComposeRecordingDraft({
        useEmbeddedAudio: sourceMode === "clip",
        voiceReplace: sourceMode === "recording2",
      }),
    );
    setQuestionPaste("");
    setEditingSceneId(null);
    setExtractingClipAudio(false);
    setProcessingRecording2(false);
    clearComposeWorkingDraft(projectId);
  }

  async function handleLoadPartForEdit(
    part: ProjectPart,
    opts?: { skipConfirm?: boolean },
  ) {
    if (!projectId || !project) return;
    const currentScenes = (project.scenes as Scene[] | undefined) ?? [];
    if (
      !opts?.skipConfirm &&
      currentScenes.length > 0 &&
      !confirm(
        `Load "${part.title}" for editing? Scenes in the current part list will be replaced.`,
      )
    ) {
      return;
    }
    // Never write to SQLite on load — that used to wipe other collaborators' scenes
    // with a stale parts blob. Selection is local UI state only.
    setSelectedPartId(part.id);
    setPartTitle(part.title);
    const partScenes = (Array.isArray(part.scenes) ? part.scenes : []) as Scene[];
    const leftoverScript =
      (Array.isArray(part.scriptScenes) && part.scriptScenes.length > 0) ||
      !!part.script?.trim();

    // Empty stitch is authoritative — never rematerialize stubs from leftover
    // scriptScenes (that was bringing deleted scenes back after refresh).
    if (partScenes.length === 0) {
      const empty: PartScriptPlan = { scenes: [] };
      setPartScriptPlan(empty);
      lastSavedScriptKeyRef.current = JSON.stringify(empty.scenes);
      scriptAutosaveSeqRef.current += 1;
      setPartScriptSaveStatus("saved");
      setStitchActive(false);
      setEditingSceneId(null);
      resetSceneDraft();
      if (leftoverScript) {
        try {
          const fresh = await loadFreshProjectParts();
          const now = new Date().toISOString();
          const nextParts = fresh.parts.map((p) =>
            p.id === part.id
              ? {
                  ...p,
                  scenes: [],
                  scriptScenes: [],
                  script: "",
                  updated_at: now,
                }
              : p,
          );
          await apiSaveProject({
            id: projectId,
            title: fresh.record.title,
            script: "",
            audio_mode: (fresh.record.audio_mode as "tts" | "upload") || "tts",
            scenes: [],
            parts: nextParts,
            thumbnail_url: fresh.record.thumbnail_url ?? undefined,
            course_id: fresh.record.course_id ?? undefined,
            allow_scene_shrink: true,
          });
          qc.setQueryData(["project", projectId], (prev: unknown) => {
            if (!prev || typeof prev !== "object") return prev;
            return {
              ...(prev as Record<string, unknown>),
              scenes: [],
              parts: nextParts,
              script: "",
            };
          });
        } catch {
          /* empty UI already applied */
        }
      }
      return;
    }

    const hadScriptOrScenes = partScenes.length > 0 || leftoverScript;
    const aligned = alignScriptAndComposeScenes(
      partScriptPlanFromPart(part),
      partScenes,
      { preferComposeOrder: true },
    );
    setPartScriptPlan(aligned.plan);
    lastSavedScriptKeyRef.current = JSON.stringify(aligned.plan.scenes);
    setPartScriptSaveStatus("saved");
    setStitchActive(false);
    setEditingSceneId(null);
    resetSceneDraft();

    // Persist materialized stubs / relinks so Script and Stitch stay 1:1.
    // Skip brand-new empty parts (avoid inventing an Intro stub on first open).
    if (aligned.changed && hadScriptOrScenes) {
      try {
        const fresh = await loadFreshProjectParts();
        const now = new Date().toISOString();
        const nextParts = fresh.parts.map((p) =>
          p.id === part.id
            ? {
                ...p,
                scenes: aligned.scenes,
                scriptScenes: aligned.plan.scenes,
                script: partScriptPlanToText(aligned.plan),
                updated_at: now,
              }
            : p,
        );
        await apiSaveProject({
          id: projectId,
          title: fresh.record.title,
          script: partScriptPlanToText(aligned.plan),
          audio_mode: (fresh.record.audio_mode as "tts" | "upload") || "tts",
          scenes: aligned.scenes,
          parts: nextParts,
          thumbnail_url: fresh.record.thumbnail_url ?? undefined,
          course_id: fresh.record.course_id ?? undefined,
          allow_scene_shrink:
            aligned.scenes.length < partScenes.length ? true : undefined,
        });
        qc.setQueryData(["project", projectId], (prev: unknown) => {
          if (!prev || typeof prev !== "object") return prev;
          return {
            ...(prev as Record<string, unknown>),
            scenes: aligned.scenes,
            parts: nextParts,
            script: partScriptPlanToText(aligned.plan),
          };
        });
      } catch {
        /* local plan already aligned; save can retry on next edit */
      }
    }
  }

  /** Deep-link `/compose?project=&part=` from the episode parts page. */
  const autoLoadedPartKey = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !project || !partFromSearch) return;
    if (hydratedProjectId !== projectId) return;
    const key = `${projectId}:${partFromSearch}`;
    if (autoLoadedPartKey.current === key) return;
    const part = accessibleParts.find((p) => p.id === partFromSearch);
    if (!part) return;
    autoLoadedPartKey.current = key;
    // Always load the saved part (including scriptScenes), even if selectedPartId
    // already matches — session draft may have left an empty placeholder plan.
    void handleLoadPartForEdit(part, { skipConfirm: true });
  }, [projectId, project, partFromSearch, hydratedProjectId, accessibleParts]);

  function handleEditScene(scene: Scene, _index: number) {
    const mode = sceneSourceMode(scene);
    switchSourceMode(mode);
    if (mode === "code") {
      const d = sceneToCodeDraft(scene);
      if (d) setCodeDraft(d);
    } else if (mode === "question") {
      const d = sceneToQuestionDraft(scene);
      if (d) setQuestionDraft(d);
    } else if (mode === "template") {
      const d = sceneToTemplateDraft(scene);
      if (d) {
        setTemplateDraft(d);
        if (d.mode === "fixed") setBackgroundPreset("video-loop");
        if (d.templateKind === "codeTyping") {
          const code = sceneToCodeDraft(scene);
          if (code) setCodeDraft(code);
          setBackgroundPreset("video-loop");
        }
      }
    } else if (mode === "recording" || mode === "recording2" || mode === "clip") {
      const d = sceneToRecordingDraft(scene);
      if (d) {
        setRecordingDraft({
          ...d,
          useEmbeddedAudio: mode === "clip" || d.useEmbeddedAudio,
          voiceReplace: mode === "recording2" || d.voiceReplace,
        });
        if (d.audioUrl) {
          void probeAudioDurationMs(d.audioUrl).then((ms) => {
            if (ms && ms > 0) {
              setRecordingDraft((prev) =>
                prev.mediaUrl === d.mediaUrl
                  ? {
                      ...prev,
                      audioDurationMs: ms,
                      audioSegments:
                        prev.audioSegments.length > 0
                          ? prev.audioSegments
                          : [singleRecordingAudioSegment(ms)],
                      ready: true,
                    }
                  : prev,
              );
            }
          });
        }
      }
      setOpenSteps(
        mode === "clip"
          ? ["setup", "edit", "preview"]
          : mode === "recording2"
            ? ["setup", "edit"]
            : ["setup"],
      );
    } else {
      const d = sceneToComposeDraft(scene);
      if (d) {
        setDraft(d);
        if (d.compositeUrl) setUploadDataUrl(d.compositeUrl);
      }
    }
    setEditingSceneId(scene.id);
    setShowPreview(false);
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handlePartSaved(nextPartTitle: string, opts?: { updated?: boolean }) {
    setPartTitle(nextPartTitle);
    if (!opts?.updated) {
      // Keep the assigned/URL part selected so later scene saves stay isolated.
      if (!partFromSearch && (isAdmin || accessibleParts.length !== 1)) {
        setSelectedPartId(null);
      }
      resetSceneDraft();
    } else {
      setEditingSceneId(null);
    }
    setStitchActive(false);
  }

  async function handleGoToScriptScene(scene: PartScriptScene) {
    if (scene.type === "unset") {
      setError("Pick a scene type before continuing.");
      return;
    }
    const mode = composeModeForPartScriptType(scene);
    const title = scene.name.trim() || "Scene";
    const script = scene.script.trim();
    const audioUrl = scene.audioUrl ?? null;
    const durationMs = scene.durationMs && scene.durationMs > 0 ? scene.durationMs : 0;

    setError(null);
    setShowPreview(false);
    setEditingSceneId(null);

    // Shared brand bumper — add straight to the part (no compose steps).
    if (scene.type === "intro" || scene.type === "outro") {
      if (!projectId || !project) {
        setError("Open a part from an episode first.");
        return;
      }
      if (!partTitle.trim()) {
        setError("Part name is missing — reopen the part from the episode page.");
        return;
      }
      if (!activePartId) {
        setError("Open your assigned part from the episode page before saving scenes.");
        return;
      }
      const label = scene.type === "intro" ? "Intro" : "Outro";
      setSaving(true);
      try {
        const fresh = await loadFreshProjectParts();
        const existingScenes = fresh.scenes;
        const linkedId = composeIdFromScriptSceneId(scene.id);
        const replaceIdx = linkedId
          ? existingScenes.findIndex((s) => s.id === linkedId)
          : label === "Intro"
            ? existingScenes.findIndex((s) => s.subtitle === "Intro")
            : existingScenes.findIndex((s) => s.subtitle === "Outro");
        const existingSceneId =
          linkedId ??
          (replaceIdx >= 0 ? existingScenes[replaceIdx]?.id : undefined);
        const durableScene = await persistSceneAssetsForSave(
          commonIntroOutroScene(label, existingSceneId),
          projectId,
          (input) => apiPersistAsset(input),
        );
        let nextScenes: Scene[];
        if (replaceIdx >= 0) {
          nextScenes = existingScenes.map((s, i) =>
            i === replaceIdx ? durableScene : s,
          );
        } else if (label === "Intro") {
          nextScenes = [durableScene, ...existingScenes];
        } else {
          nextScenes = [...existingScenes, durableScene];
        }
        const now = new Date().toISOString();
        const nextPlan = mergeScriptPlanWithComposeScenes(partScriptPlan, nextScenes);
        const nextParts = fresh.parts.map((p) =>
          p.id === activePartId
            ? {
                ...p,
                scenes: nextScenes,
                scriptScenes: nextPlan.scenes,
                script: partScriptPlanToText(nextPlan),
                updated_at: now,
              }
            : p,
        );
        await apiSaveProject({
          id: projectId,
          title: fresh.record.title,
          script: partScriptPlanToText(nextPlan) || fresh.record.script || "",
          audio_mode: "tts",
          scenes: nextScenes,
          parts: nextParts,
          thumbnail_url: fresh.record.thumbnail_url ?? undefined,
        });
        rememberLastProject(projectId);
        setPartScriptPlan(nextPlan);
        lastSavedScriptKeyRef.current = JSON.stringify(nextPlan.scenes);
        setPartScriptSaveStatus("saved");
        qc.setQueryData(["project", projectId], (prev: unknown) => {
          if (!prev || typeof prev !== "object") return prev;
          return {
            ...(prev as Record<string, unknown>),
            scenes: nextScenes,
            parts: nextParts,
          };
        });
        void qc.invalidateQueries({ queryKey: ["projects"] });
        // switchSourceMode resets the recording draft — set the bumper after it.
        switchSourceMode("clip");
        setEditingSceneId(durableScene.id);
        setRecordingDraft(commonIntroOutroRecordingDraft(label));
        setOpenSteps(["setup"]);
        if (activePartId) setSelectedPartId(activePartId);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
      return;
    }

    const linkedComposeId =
      composeIdFromScriptSceneId(scene.id) ??
      `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // Ensure Script plan has this row's latest type before handoff saves/merges
    // (type-change → open can race React state).
    const planForHandoff: PartScriptPlan = {
      ...partScriptPlan,
      scenes: partScriptPlan.scenes.some((s) => s.id === scene.id)
        ? partScriptPlan.scenes.map((s) =>
            s.id === scene.id ? { ...s, ...scene } : s,
          )
        : [...partScriptPlan.scenes, scene],
    };
    setPartScriptPlan(planForHandoff);

    switchSourceMode(mode);
    setEditingSceneId(linkedComposeId);

    async function upsertLinkedComposeScene(built: Scene): Promise<Scene | null> {
      if (!projectId || !activePartId || !project) return null;
      try {
        const durableScene = await persistSceneAssetsForSave(
          built,
          projectId,
          (input) => apiPersistAsset(input),
        );
        const fresh = await loadFreshProjectParts();
        const existingScenes = fresh.scenes;
        const idx = existingScenes.findIndex((s) => s.id === durableScene.id);
        const nextScenes =
          idx >= 0
            ? existingScenes.map((s, i) => (i === idx ? durableScene : s))
            : [...existingScenes, durableScene];
        const now = new Date().toISOString();
        const nextPlan = mergeScriptPlanWithComposeScenes(planForHandoff, nextScenes);
        const nextParts = fresh.parts.map((p) =>
          p.id === activePartId
            ? {
                ...p,
                scenes: nextScenes,
                scriptScenes: nextPlan.scenes,
                script: partScriptPlanToText(nextPlan),
                updated_at: now,
              }
            : p,
        );
        await apiSaveProject({
          id: projectId,
          title: fresh.record.title,
          script: partScriptPlanToText(nextPlan) || fresh.record.script || "",
          audio_mode: "tts",
          scenes: nextScenes,
          parts: nextParts,
          thumbnail_url: fresh.record.thumbnail_url ?? undefined,
          course_id: fresh.record.course_id ?? undefined,
        });
        rememberLastProject(projectId);
        setPartScriptPlan(nextPlan);
        lastSavedScriptKeyRef.current = JSON.stringify(nextPlan.scenes);
        setPartScriptSaveStatus("saved");
        qc.setQueryData(["project", projectId], (prev: unknown) => {
          if (!prev || typeof prev !== "object") return prev;
          return {
            ...(prev as Record<string, unknown>),
            scenes: nextScenes,
            parts: nextParts,
            updated_at: now,
          };
        });
        void qc.invalidateQueries({ queryKey: ["projects"] });
        setEditingSceneId(durableScene.id);
        return durableScene;
      } catch (e: unknown) {
        setError(
          e instanceof Error
            ? e.message
            : "Could not sync this scene from Script — finish steps on this tab.",
        );
        return null;
      }
    }

    function openHandoffPreview(steps: string[]) {
      setOpenSteps(steps);
      setShowPreview(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    if (mode === "upload") {
      let bgAspect = COMPOSITE_ASPECT;
      if (scene.imageUrl) {
        try {
          const imgEl = await loadImage(scene.imageUrl);
          bgAspect =
            (imgEl.naturalWidth || 1536) / (imgEl.naturalHeight || 1024) ||
            COMPOSITE_ASPECT;
        } catch {
          /* keep default aspect */
        }
      }
      const cropId = `crop-full-${Date.now().toString(36)}`;
      const nextDraft: ComposeDraft = {
        ...emptyComposeDraft(),
        script,
        title,
        compositeUrl: scene.imageUrl ?? null,
        audioUrl,
        durationMs,
        bgAspect,
        crops: scene.imageUrl
          ? [
              {
                id: cropId,
                name: "Full image",
                imageUrl: scene.imageUrl,
                bbox: { x: 0, y: 0, w: 1, h: 1 },
              },
            ]
          : [],
        placements: scene.imageUrl
          ? [
              {
                id: `plc-${Date.now().toString(36)}`,
                cropId,
                startMs: 0,
              },
            ]
          : [],
      };
      setDraft(nextDraft);
      setUploadDataUrl(scene.imageUrl ?? null);
      if (nextDraft.crops[0]) setSelectedCropId(nextDraft.crops[0].id);
      const built = composeDraftToScene(nextDraft, linkedComposeId);
      if (built) {
        await upsertLinkedComposeScene(built);
        openHandoffPreview(["image", "crop", "audio", "preview", "save"]);
      } else if (scene.imageUrl) {
        setOpenSteps(["image", "crop", "audio"]);
      } else {
        setOpenSteps(["image"]);
      }
      return;
    }

    if (mode === "template") {
      if (scene.templateSubtype === "codeTyping") {
        const cps = DEFAULT_CODE_TYPING_CPS;
        const rawBeats =
          scene.codeTypingBeats?.length &&
          scene.codeTypingBeats.some((b) => b.code.trim() || b.output.trim())
            ? scene.codeTypingBeats
            : [
                emptyCodeTypingBeat({
                  code: scene.code?.trim() || DEFAULT_CODE_TYPING_SNIPPET,
                  output: DEFAULT_CODE_TYPING_OUTPUT,
                }),
              ];
        const beats = rawBeats.map((b) =>
          emptyCodeTypingBeat({
            id: b.id,
            code: b.code,
            output: b.output,
            outputHoldMs: b.outputHoldMs,
            runDelayMs: b.runDelayMs,
          }),
        );
        const fullCode = beatsToFullCode(beats);
        const suggested = suggestedBeatsDurationMs(beats, cps);
        const duration = Math.max(2000, suggested);
        let silentUrl: string | null = null;
        try {
          const silent = await createSilentAudioUrl(duration);
          silentUrl = silent.url;
        } catch {
          silentUrl = null;
        }
        const nextCode: ComposeCodeDraft = {
          ...emptyComposeCodeDraft(),
          script: "",
          title: title || "hello.py",
          code: fullCode,
          codeLanguage: "py",
          codeVariant: "typing",
          audioUrl: silentUrl,
          durationMs: duration,
          ready: !!silentUrl,
          silentNarration: true,
          typingSpeedCps: cps,
          codeOutput: beats[0]?.output ?? "",
          codeRunDelayMs: beats[0]?.runDelayMs,
          codeOutputHoldMs: beats[0]?.outputHoldMs,
          codeTypingBeats: beats,
        };
        setTemplateDraft({
          ...emptyComposeTemplateDraft("codeTyping"),
          picked: true,
          templateKind: "codeTyping",
          script: "",
          title,
          audioUrl: silentUrl,
          durationMs: duration,
          ready: !!silentUrl,
        });
        setCodeDraft(nextCode);
        setBackgroundPreset("video-loop");
        const built = composeCodeDraftToScene(nextCode, linkedComposeId, {
          fromTemplate: true,
        });
        if (built) {
          await upsertLinkedComposeScene(built);
          openHandoffPreview(["setup", "preview", "save"]);
        } else {
          setOpenSteps(["setup"]);
        }
      } else {
        const kind = scene.templateSubtype === "typing" ? "typing" : "text";
        const text = scene.templateText?.trim() || "Your headline here";
        let previewUrl: string | null = null;
        try {
          previewUrl = await renderTemplatePreviewDataUrl({
            type: kind,
            text,
            color: "#1a1a1a",
            fontSize: 72,
            countdownSec: 5,
          });
        } catch {
          previewUrl = null;
        }
        const nextTemplate: ComposeTemplateDraft = {
          ...emptyComposeTemplateDraft(kind),
          picked: true,
          templateKind: kind,
          text,
          script,
          title,
          audioUrl,
          durationMs,
          ready: !!(audioUrl && durationMs > 0),
          previewUrl,
        };
        setTemplateDraft(nextTemplate);
        const built = composeTemplateDraftToScene(nextTemplate, linkedComposeId);
        if (built) {
          await upsertLinkedComposeScene(built);
          openHandoffPreview(["setup", "audio", "preview", "save"]);
        } else {
          setOpenSteps(["setup", "audio"]);
        }
      }
      return;
    }

    if (mode === "code") {
      const cps = DEFAULT_CODE_TYPING_CPS;
      const rawBeats =
        scene.codeTypingBeats?.length &&
        scene.codeTypingBeats.some((b) => b.code.trim() || b.output.trim())
          ? scene.codeTypingBeats
          : scene.code?.trim()
            ? [emptyCodeTypingBeat({ code: scene.code.trim(), output: "" })]
            : [emptyCodeTypingBeat({ code: DEFAULT_CODE_TYPING_SNIPPET, output: "" })];
      const beats = rawBeats.map((b) =>
        emptyCodeTypingBeat({
          id: b.id,
          code: b.code,
          output: b.output,
          outputHoldMs: b.outputHoldMs,
          runDelayMs: b.runDelayMs,
        }),
      );
      const fullCode = beatsToFullCode(beats);
      const nextCode: ComposeCodeDraft = {
        ...emptyComposeCodeDraft(),
        script,
        title: title || "hello.py",
        code: fullCode,
        codeLanguage: "py",
        codeVariant: "typing",
        audioUrl,
        durationMs,
        ready: !!(audioUrl && durationMs > 0),
        typingSpeedCps: cps,
        codeOutput: beats[0]?.output ?? "",
        codeRunDelayMs: beats[0]?.runDelayMs,
        codeOutputHoldMs: beats[0]?.outputHoldMs,
        codeTypingBeats: beats,
      };
      setCodeDraft(nextCode);
      const built = composeCodeDraftToScene(nextCode, linkedComposeId);
      if (built) {
        await upsertLinkedComposeScene(built);
        openHandoffPreview(["setup", "audio", "preview", "save"]);
      } else {
        setOpenSteps(["setup", "audio"]);
      }
      return;
    }

    if (mode === "question") {
      const sub = scene.questionSubtype ?? "mcq";
      const isCoding = sub === "coding";
      const isPredict = sub === "predictOutput";
      const kind: QuestionKind = isCoding
        ? "coding"
        : isPredict
          ? "predictOutput"
          : sub === "msq"
            ? "msq"
            : "mcq";
      let next: ComposeQuestionDraft = {
        ...emptyComposeQuestionDraft(kind),
        script,
        title,
        audioUrl,
        durationMs,
        ready: false,
        codingPaste: isCoding ? scene.codingPaste || "" : "",
        predictCode: isPredict ? scene.code || "" : "",
      };

      if (isCoding && (scene.codingPaste || "").trim()) {
        const raw = scene.codingPaste!.trim();
        setQuestionPaste(raw);
        const parsed = parseCodingProblemText(raw);
        if (parsed) {
          next = {
            ...next,
            codingTitle: parsed.title || next.codingTitle,
            question: parsed.instruction || next.question,
            codingStarterCode: parsed.starterCode || next.codingStarterCode,
            codingTestCases: (() => {
              const blank = { label: "", input: "", output: "" };
              const mapped = parsed.testCases.slice(0, 3).map((t, i) => ({
                label: t.label || `Case ${i + 1}`,
                input: t.input,
                output: t.output,
              }));
              while (mapped.length < 3) mapped.push({ ...blank });
              return mapped as ComposeQuestionDraft["codingTestCases"];
            })(),
            codingPaste: raw,
          };
        }
      } else if ((scene.questionPaste || "").trim()) {
        const raw = scene.questionPaste!.trim();
        setQuestionPaste(raw);
        const hint = isPredict ? "predictOutput" : kind === "msq" ? "msq" : "mcq";
        const local = parseQuestionTextFallback(raw, hint);
        if (local) {
          next = {
            ...next,
            kind:
              local.kind === "predictOutput"
                ? "predictOutput"
                : local.kind === "msq"
                  ? "msq"
                  : local.kind === "mcq"
                    ? "mcq"
                    : next.kind,
            question: local.question || next.question,
            options: local.options ?? next.options,
            predictCode:
              local.kind === "predictOutput"
                ? local.predictCode ?? next.predictCode
                : next.predictCode,
            predictSelectMode:
              local.kind === "predictOutput"
                ? local.predictSelectMode ?? next.predictSelectMode
                : next.predictSelectMode,
          };
        }
      }

      try {
        const intro = isCoding
          ? await apiEnsureCodingIntroDefaultTts()
          : await apiEnsureIntroDefaultTts();
        const mark = isCoding
          ? await apiEnsureCodingMarkDefaultTts()
          : await apiEnsureMarkDefaultTts();
        const introMs = (await probeAudioDurationMs(intro.audioUrl)) ?? 0;
        const markMs = (await probeAudioDurationMs(mark.audioUrl)) ?? 0;
        next = {
          ...next,
          introText: intro.text,
          introAudioUrl: intro.audioUrl,
          introAudioForText: intro.text,
          introDurationMs: introMs || next.introDurationMs,
          markText: mark.text,
          markAudioUrl: mark.audioUrl,
          markAudioForText: mark.text,
          markDurationMs: markMs || next.markDurationMs,
        };
        setIntroDefaultLoaded(true);
        setMarkDefaultLoaded(true);
      } catch {
        /* user can still load defaults on the Questions tab */
      }

      next = {
        ...next,
        ready: !!(next.audioUrl && next.durationMs > 0),
      };
      setQuestionDraft(next);
      const built = composeQuestionDraftToScene(next, linkedComposeId);
      if (built) {
        await upsertLinkedComposeScene(built);
        openHandoffPreview(["setup", "audio", "preview", "save"]);
      } else {
        setOpenSteps(["setup", "audio"]);
      }
      return;
    }

    if (mode === "recording2") {
      const existingScenes =
        ((project?.scenes as Scene[] | undefined) ??
          (activeComposeScenes as Scene[])) ??
        [];
      const existing = existingScenes.find((s) => s.id === linkedComposeId);
      const fromExisting = existing ? sceneToRecordingDraft(existing) : null;
      if (fromExisting?.mediaUrl && fromExisting.ready && fromExisting.audioUrl) {
        setRecordingDraft({
          ...fromExisting,
          script: script || fromExisting.script,
          title: title || fromExisting.title,
          useEmbeddedAudio: false,
          voiceReplace: true,
        });
        openHandoffPreview(["setup", "edit", "preview", "save"]);
        return;
      }
      const mediaMs = scene.mediaDurationMs ?? fromExisting?.sourceDurationMs ?? 0;
      const mediaUrl = scene.mediaUrl ?? fromExisting?.mediaUrl ?? null;
      const nextRec: ComposeRecordingDraft = {
        ...(fromExisting ??
          emptyComposeRecordingDraft({ voiceReplace: true })),
        script: script || fromExisting?.script || "",
        title: title || fromExisting?.title || "",
        mediaUrl,
        sourceDurationMs: mediaMs,
        trimStartMs: 0,
        trimEndMs: mediaMs,
        videoOffsetMs: 0,
        videoSegments:
          mediaUrl && mediaMs > 0
            ? [
                {
                  id: `vid-${Date.now().toString(36)}`,
                  trimStartMs: 0,
                  trimEndMs: mediaMs,
                  offsetMs: 0,
                  rate: 1,
                },
              ]
            : [],
        useEmbeddedAudio: false,
        voiceReplace: true,
        audioUrl: fromExisting?.audioUrl ?? null,
        audioDurationMs: fromExisting?.audioDurationMs ?? 0,
        audioSegments: fromExisting?.audioSegments ?? [],
        voicePhrases: fromExisting?.voicePhrases,
        ready: !!(fromExisting?.ready && fromExisting.audioUrl),
      };
      setRecordingDraft(nextRec);
      if (nextRec.ready && nextRec.mediaUrl && nextRec.audioUrl) {
        const built = composeRecordingDraftToScene(nextRec, linkedComposeId);
        if (built) {
          await upsertLinkedComposeScene(built);
          openHandoffPreview(["setup", "edit", "preview", "save"]);
        } else {
          setOpenSteps(["setup", "edit"]);
        }
      } else {
        setOpenSteps(["setup"]);
      }
      return;
    }

    if (mode === "clip") {
      const existingScenes =
        ((project?.scenes as Scene[] | undefined) ??
          (activeComposeScenes as Scene[])) ??
        [];
      const existing = existingScenes.find((s) => s.id === linkedComposeId);
      const fromExisting = existing ? sceneToRecordingDraft(existing) : null;
      if (fromExisting?.mediaUrl && fromExisting.ready && fromExisting.audioUrl) {
        setRecordingDraft({
          ...fromExisting,
          script: script || fromExisting.script,
          title: title || fromExisting.title,
          useEmbeddedAudio: true,
          voiceReplace: false,
          cameraZoomSfx: fromExisting.cameraZoomSfx ?? "none",
        });
        openHandoffPreview(["setup", "edit", "preview", "save"]);
        return;
      }
      const mediaMs = scene.mediaDurationMs ?? fromExisting?.sourceDurationMs ?? 0;
      const mediaUrl = scene.mediaUrl ?? fromExisting?.mediaUrl ?? null;
      setRecordingDraft({
        ...(fromExisting ?? emptyComposeRecordingDraft({ useEmbeddedAudio: true })),
        script: script || fromExisting?.script || "",
        title: title || fromExisting?.title || "",
        mediaUrl,
        sourceDurationMs: mediaMs,
        trimStartMs: 0,
        trimEndMs: mediaMs,
        videoOffsetMs: 0,
        videoSegments:
          mediaUrl && mediaMs > 0
            ? [
                {
                  id: `vid-${Date.now().toString(36)}`,
                  trimStartMs: 0,
                  trimEndMs: mediaMs,
                  offsetMs: 0,
                  rate: 1,
                },
              ]
            : [],
        useEmbeddedAudio: true,
        voiceReplace: false,
        cameraZoomSfx: fromExisting?.cameraZoomSfx ?? "none",
        audioUrl: fromExisting?.audioUrl ?? null,
        audioDurationMs: fromExisting?.audioDurationMs ?? 0,
        audioSegments: fromExisting?.audioSegments ?? [],
        ready: !!(fromExisting?.ready && fromExisting.audioUrl),
      });
      if (projectId && mediaUrl) {
        try {
          const audio = await apiExtractVideoAudio({
            projectId,
            videoUrl: mediaUrl,
            durationMs: mediaMs,
          });
          const audioDurationMs = audio.durationMs || mediaMs;
          const nextRec: ComposeRecordingDraft = {
            ...(fromExisting ??
              emptyComposeRecordingDraft({ useEmbeddedAudio: true })),
            script: script || fromExisting?.script || "",
            title: title || fromExisting?.title || "",
            mediaUrl,
            sourceDurationMs: mediaMs,
            trimStartMs: 0,
            trimEndMs: mediaMs,
            videoOffsetMs: 0,
            videoSegments: [
              {
                id: `vid-${Date.now().toString(36)}`,
                trimStartMs: 0,
                trimEndMs: mediaMs,
                offsetMs: 0,
                rate: 1,
              },
            ],
            useEmbeddedAudio: true,
            voiceReplace: false,
            cameraZoomSfx: fromExisting?.cameraZoomSfx ?? "none",
            audioUrl: audio.url,
            audioDurationMs,
            audioSegments: [singleRecordingAudioSegment(audioDurationMs)],
            ready: true,
          };
          setRecordingDraft(nextRec);
          const built = composeRecordingDraftToScene(nextRec, linkedComposeId);
          if (built) {
            await upsertLinkedComposeScene(built);
            openHandoffPreview(["setup", "edit", "preview", "save"]);
          } else {
            setOpenSteps(["setup", "edit", "preview"]);
          }
        } catch (e: unknown) {
          // Demux failed — keep the clip usable with its own embedded audio
          // instead of dropping the user back to an unusable setup step.
          const fallback: ComposeRecordingDraft = {
            ...(fromExisting ??
              emptyComposeRecordingDraft({ useEmbeddedAudio: true })),
            script: script || fromExisting?.script || "",
            title: title || fromExisting?.title || "",
            mediaUrl,
            sourceDurationMs: mediaMs,
            trimStartMs: 0,
            trimEndMs: mediaMs,
            videoOffsetMs: 0,
            videoSegments: [
              {
                id: `vid-${Date.now().toString(36)}`,
                trimStartMs: 0,
                trimEndMs: mediaMs,
                offsetMs: 0,
                rate: 1,
              },
            ],
            useEmbeddedAudio: true,
            voiceReplace: false,
            cameraZoomSfx: fromExisting?.cameraZoomSfx ?? "none",
            audioUrl: null,
            audioDurationMs: 0,
            audioSegments: [],
            ready: true,
          };
          setRecordingDraft(fallback);
          console.warn("[clip] audio extraction skipped:", e);

          setOpenSteps(["setup", "edit", "preview"]);
        }

      } else {
        setOpenSteps(["setup"]);
      }
    }
  }

  async function handlePartScriptPlanChange(nextPlan: PartScriptPlan) {
    const prevOrder = partScriptPlan.scenes.map((s) => s.id).join("|");
    const nextOrder = nextPlan.scenes.map((s) => s.id).join("|");
    const prevTypes = partScriptPlan.scenes.map((s) => s.type).join("|");
    const nextTypes = nextPlan.scenes.map((s) => s.type).join("|");
    setPartScriptPlan(nextPlan);
    // Text-only edits: don't touch stitch. Sync when membership, order, or type changes.
    if (
      (prevOrder === nextOrder && prevTypes === nextTypes) ||
      !projectId ||
      !activePartId
    ) {
      return;
    }
    // Invalidate in-flight script autosaves so they can't resurrect deleted rows.
    scriptAutosaveSeqRef.current += 1;
    setSavingPartScript(true);
    setPartScriptSaveStatus("saving");
    try {
      const fresh = await loadFreshProjectParts();
      // Script is source of truth here (Remove / reorder / type change).
      const aligned = alignScriptAndComposeScenes(
        nextPlan,
        fresh.scenes as Scene[],
      );
      // Keep incomplete stubs' kind/subtitle in sync with Script type/name.
      const scenes = aligned.scenes.map((cs, i) => {
        const row = aligned.plan.scenes[i];
        if (!row) return cs;
        if (sceneCompletionProgress(row, cs).complete) return cs;
        const stub = composeStubFromScriptScene(row, cs.id, i + 1);
        const wasBumper =
          cs.subtitle === "Intro" || cs.subtitle === "Outro";
        const nowBumper = row.type === "intro" || row.type === "outro";
        const typeChanged =
          stub.kind !== cs.kind || wasBumper !== nowBumper || stub.subtitle !== cs.subtitle;
        // Type changed away from Intro/etc. — don't keep old bumper media.
        if (typeChanged) return stub;
        return {
          ...stub,
          mediaUrl: cs.mediaUrl ?? stub.mediaUrl,
          audioUrl: cs.audioUrl || stub.audioUrl,
          durationMs: cs.durationMs || stub.durationMs,
          backgroundUrl: cs.backgroundUrl ?? stub.backgroundUrl,
          compositeThumbUrl: cs.compositeThumbUrl ?? stub.compositeThumbUrl,
          elements: cs.elements ?? stub.elements,
          recordingUseEmbeddedAudio: cs.recordingUseEmbeddedAudio,
          recordingSourceDurationMs: cs.recordingSourceDurationMs,
        };
      });
      const shrunk = scenes.length < fresh.scenes.length;
      const orderChanged =
        shrunk ||
        scenes.length !== fresh.scenes.length ||
        scenes.some((s, i) => s.id !== fresh.scenes[i]?.id);
      const typeMetaChanged = prevTypes !== nextTypes;
      // Always persist when membership/order/type changed — even if align
      // thought nothing changed (e.g. only stub metadata needed updating).
      if (!aligned.changed && !orderChanged && !typeMetaChanged) {
        lastSavedScriptKeyRef.current = JSON.stringify(nextPlan.scenes);
        setPartScriptSaveStatus("saved");
        return;
      }
      // Keep the user's Script plan (types/names) — do not replace with a
      // compose-derived plan that can snap type back to Intro.
      const planToSave = aligned.plan.scenes.length
        ? {
            scenes: aligned.plan.scenes.map((row, i) => {
              const fromUser = nextPlan.scenes.find((s) => s.id === row.id);
              return fromUser ? { ...row, ...fromUser, id: row.id } : row;
            }),
          }
        : aligned.plan;
      setPartScriptPlan(planToSave);
      const now = new Date().toISOString();
      const nextParts = fresh.parts.map((p) =>
        p.id === activePartId
          ? {
              ...p,
              scenes,
              scriptScenes: planToSave.scenes,
              script: partScriptPlanToText(planToSave),
              updated_at: now,
            }
          : p,
      );
      await apiSaveProject({
        id: projectId,
        title: fresh.record.title,
        script: partScriptPlanToText(planToSave),
        audio_mode: (fresh.record.audio_mode as "tts" | "upload") || "tts",
        scenes,
        parts: nextParts,
        thumbnail_url: fresh.record.thumbnail_url ?? undefined,
        course_id: fresh.record.course_id ?? undefined,
        allow_scene_shrink: shrunk || scenes.length === 0,
      });
      lastSavedScriptKeyRef.current = JSON.stringify(planToSave.scenes);
      setPartScriptSaveStatus("saved");
      qc.setQueryData(["project", projectId], (prev: unknown) => {
        if (!prev || typeof prev !== "object") return prev;
        return {
          ...(prev as Record<string, unknown>),
          scenes,
          parts: nextParts,
          script: partScriptPlanToText(planToSave),
        };
      });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    } catch {
      // Script local state already updated; stitch sync can retry on next edit/save.
      setPartScriptSaveStatus("error");
    } finally {
      setSavingPartScript(false);
    }
  }

  function handlePartScriptPlanSynced(plan: PartScriptPlan) {
    setPartScriptPlan(plan);
    lastSavedScriptKeyRef.current = JSON.stringify(plan.scenes);
    scriptAutosaveSeqRef.current += 1;
    setPartScriptSaveStatus("saved");
  }

  async function handleSavePartScript(opts?: { silent?: boolean }) {
    const silent = opts?.silent === true;
    if (!projectId || !project) {
      if (!silent) setError("Open a part from an episode first.");
      return;
    }
    if (!partTitle.trim()) {
      if (!silent) setError("Part name is missing — reopen the part from the episode page.");
      return;
    }
    // Background autosave: persist exactly what is on screen — never rewrite form state mid-edit.
    let planToSave = partScriptPlan;
    if (!silent) {
      try {
        const freshForSync = await loadFreshProjectParts();
        if (freshForSync.scenes.length > 0) {
          const synced = syncScriptPlanWithComposeScenes(
            partScriptPlan,
            freshForSync.scenes,
          );
          const before = JSON.stringify(partScriptPlan.scenes.map((s) => s.id));
          const after = JSON.stringify(synced.scenes.map((s) => s.id));
          planToSave = synced;
          if (before !== after) setPartScriptPlan(synced);
        }
      } catch {
        /* use current plan */
      }
    }
    if (!partScriptPlanHasContent(planToSave)) {
      // Only persist a clear when the plan truly has zero rows (deleted all).
      // A row with empty fields still counts as a scene and must not wipe stitch.
      if (planToSave.scenes.length === 0 && projectId && activePartId) {
        const seq = ++scriptAutosaveSeqRef.current;
        if (!silent) {
          setSavingPartScript(true);
          setPartScriptSaveStatus("saving");
          setError(null);
        }
        try {
          const fresh = await loadFreshProjectParts();
          if (seq !== scriptAutosaveSeqRef.current) return;
          const now = new Date().toISOString();
          const nextParts = fresh.parts.map((p) =>
            p.id === activePartId
              ? {
                  ...p,
                  script: "",
                  scriptScenes: [],
                  scenes: [],
                  updated_at: now,
                }
              : p,
          );
          await apiSaveProject({
            id: projectId,
            title: fresh.record.title,
            script: "",
            audio_mode: (fresh.record.audio_mode as "tts" | "upload") || "tts",
            scenes: [],
            parts: nextParts,
            thumbnail_url: fresh.record.thumbnail_url ?? undefined,
            course_id: fresh.record.course_id ?? undefined,
            allow_scene_shrink: true,
          });
          if (seq !== scriptAutosaveSeqRef.current) return;
          lastSavedScriptKeyRef.current = "[]";
          setPartScriptSaveStatus("saved");
          qc.setQueryData(["project", projectId], (prev: unknown) => {
            if (!prev || typeof prev !== "object") return prev;
            return {
              ...(prev as Record<string, unknown>),
              scenes: [],
              parts: nextParts,
              script: "",
            };
          });
        } catch (e: unknown) {
          if (!silent) setError(e instanceof Error ? e.message : String(e));
          setPartScriptSaveStatus("error");
        } finally {
          if (!silent) setSavingPartScript(false);
        }
        return;
      }
      if (!silent) setError("Add at least one scene name or script before saving.");
      return;
    }
    const text = partScriptPlanToText(planToSave);
    const seq = ++scriptAutosaveSeqRef.current;
    if (!silent) {
      setSavingPartScript(true);
      setPartScriptSaveStatus("saving");
      setError(null);
    }
    try {
      const fresh = await loadFreshProjectParts();
      // A newer edit started while this save was in flight — drop this write.
      if (seq !== scriptAutosaveSeqRef.current) return;
      const parts = fresh.parts;
      let nextParts = parts;
      let nextSelected = activePartId ?? selectedPartId;
      const now = new Date().toISOString();
      if (nextSelected && parts.some((p) => p.id === nextSelected)) {
        const currentPart = parts.find((p) => p.id === nextSelected);
        const stitchCount = Array.isArray(currentPart?.scenes)
          ? currentPart!.scenes.length
          : 0;
        // Don't let a stale/silent script write reintroduce rows onto an empty stitch.
        if (silent && stitchCount === 0 && planToSave.scenes.length > 0) {
          return;
        }
        nextParts = parts.map((p) =>
          p.id === nextSelected
            ? {
                ...p,
                script: text,
                scriptScenes: planToSave.scenes,
                // Keep stitch scenes untouched during script autosave.
                scenes: p.scenes,
                updated_at: now,
              }
            : p,
        );
      } else {
        const byTitle = parts.find(
          (p) => p.title.trim().toLowerCase() === partTitle.trim().toLowerCase(),
        );
        if (byTitle) {
          nextParts = parts.map((p) =>
            p.id === byTitle.id
              ? {
                  ...p,
                  script: text,
                  scriptScenes: planToSave.scenes,
                  scenes: p.scenes,
                  updated_at: now,
                }
              : p,
          );
          nextSelected = byTitle.id;
        }
      }
      await apiSaveProject({
        id: projectId,
        title: fresh.record.title,
        script: text,
        audio_mode: fresh.record.audio_mode as "tts" | "upload",
        scenes: fresh.record.scenes ?? [],
        parts: nextParts,
        thumbnail_url: fresh.record.thumbnail_url ?? undefined,
        course_id: fresh.record.course_id ?? undefined,
      });
      if (seq !== scriptAutosaveSeqRef.current) return;
      lastSavedScriptKeyRef.current = JSON.stringify(planToSave.scenes);
      setPartScriptSaveStatus("saved");
      // Patch cache only — never invalidate (avoids remount / focus loss).
      qc.setQueryData(["project", projectId], (prev: unknown) => {
        if (!prev || typeof prev !== "object") return prev;
        return {
          ...(prev as Record<string, unknown>),
          parts: nextParts,
          script: text,
        };
      });
      if (!silent) {
        setSelectedPartId(nextSelected);
        void qc.invalidateQueries({ queryKey: ["projects"] });
      }
    } catch (e: unknown) {
      if (seq !== scriptAutosaveSeqRef.current) return;
      setPartScriptSaveStatus("error");
      if (!silent) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent && seq === scriptAutosaveSeqRef.current) {
        setSavingPartScript(false);
      }
    }
  }

  // Debounced auto-save for the Script tab (replaces manual Save click).
  useEffect(() => {
    setPartScriptSaveStatus("idle");
    if (scriptAutosaveTimerRef.current) {
      clearTimeout(scriptAutosaveTimerRef.current);
      scriptAutosaveTimerRef.current = null;
    }
  }, [projectId, activePartId]);

  useEffect(() => {
    if (!projectId || !activePartId) return;
    if (!partScriptPlanHasContent(partScriptPlan)) return;
    const key = JSON.stringify(partScriptPlan.scenes);
    if (key === lastSavedScriptKeyRef.current) return;

    // Quiet debounce — no "pending" status flicker while typing.
    if (scriptAutosaveTimerRef.current) {
      clearTimeout(scriptAutosaveTimerRef.current);
    }
    scriptAutosaveTimerRef.current = setTimeout(() => {
      void handleSavePartScript({ silent: true });
    }, 1200);

    return () => {
      if (scriptAutosaveTimerRef.current) {
        clearTimeout(scriptAutosaveTimerRef.current);
        scriptAutosaveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save on plan edits only
  }, [partScriptPlan, projectId, activePartId]);

  async function handleSaveScene(opts?: {
    /** Keep the compose form open — used by background auto-save (no UI wipe). */
    keepDraft?: boolean;
  }): Promise<boolean> {
    const keepDraft = opts?.keepDraft === true;
    const isCode = sourceMode === "code";
    const isQuestion = sourceMode === "question";
    const isTemplate = sourceMode === "template";
    const isRecording = isRecordingLikeMode(sourceMode);
    const isClip = sourceMode === "clip";
    const isRecording2 = sourceMode === "recording2";
    const isCodeTypingTemplate =
      isTemplate && templateDraft.templateKind === "codeTyping";
    const scene =
      isCode || isCodeTypingTemplate
        ? composeCodeDraftToScene(codeDraft, editingSceneId ?? undefined, {
            fromTemplate: isCodeTypingTemplate,
          })
        : isQuestion
          ? composeQuestionDraftToScene(questionDraft, editingSceneId ?? undefined)
          : isTemplate
            ? composeTemplateDraftToScene(templateDraft, editingSceneId ?? undefined)
            : isRecording
              ? composeRecordingDraftToScene(recordingDraft, editingSceneId ?? undefined)
              : composeDraftToScene(draft, editingSceneId ?? undefined);

    if (!scene) {
      setError(
        isCode || isCodeTypingTemplate
          ? isCodeTypingTemplate
            ? "Apply timing for your coding scene before saving."
            : "Generate TTS for your code scene before saving."
          : isQuestion
            ? "Generate TTS for your question scene before saving."
            : isTemplate
              ? "Generate TTS for your template scene before saving."
              : isClip
                ? "Upload a video with audio before saving."
                : isRecording2
                  ? "Upload a screen recording with mic audio and wait for voice replace to finish."
                  : isRecording
                    ? "Upload a recording and generate TTS before saving."
                    : "Generate audio and add at least one timeline placement before saving.",
      );
      return false;
    }
    if (!isCode && !isQuestion && !isTemplate && !isRecording && draft.placements.length === 0) {
      setError("Add at least one layer on the timeline before saving.");
      return false;
    }

    if (!projectId || !project) {
      setError("Create a project and name your part first.");
      return false;
    }
    if (!partTitle.trim()) {
      setError("Name your part at the top before saving scenes.");
      return false;
    }
    if (!activePartId) {
      setError("Open your assigned part from the episode page before saving scenes.");
      return false;
    }

    // Background autosave: don't flip the big `saving` flag (that locks the form).
    if (!keepDraft) {
      setSaving(true);
      setError(null);
    }
    try {
      const durableScene = await persistSceneAssetsForSave(scene, projectId, (input) =>
        apiPersistAsset(input),
      );
      const fresh = await loadFreshProjectParts();
      const existingScenes = fresh.scenes;
      const existingParts = fresh.parts;
      const script =
        fresh.record.script ??
        (isCode
          ? codeDraft.script
          : isQuestion
            ? questionDraft.script
            : isTemplate
              ? templateDraft.script
              : isRecording
                ? recordingDraft.script
                : draft.script);

      const thumbnail =
        isCode || isCodeTypingTemplate || isQuestion || isRecording
          ? undefined
          : isTemplate
            ? durableScene.backgroundUrl ?? templateDraft.previewUrl ?? undefined
            : durableScene.compositeThumbUrl ??
              draft.compositeUrl ??
              durableScene.elements?.[0]?.mediaUrl;

      let nextScenes: Scene[];
      if (editingSceneId != null) {
        const idx = existingScenes.findIndex((s) => s.id === editingSceneId);
        if (idx >= 0) {
          nextScenes = existingScenes.map((s, i) => (i === idx ? durableScene : s));
        } else {
          nextScenes = [...existingScenes, durableScene];
        }
      } else {
        nextScenes = [...existingScenes, durableScene];
      }

      const now = new Date().toISOString();
      // Merge script metadata on the server payload only — don't rewrite Script UI state mid-edit.
      const nextPlan = mergeScriptPlanWithComposeScenes(partScriptPlan, nextScenes);
      const nextParts = existingParts.map((p) =>
        p.id === activePartId
          ? {
              ...p,
              scenes: nextScenes,
              scriptScenes: nextPlan.scenes,
              script: partScriptPlanToText(nextPlan),
              updated_at: now,
            }
          : p,
      );

      await apiSaveProject({
          id: projectId,
          title: fresh.record.title,
          script,
          audio_mode: "tts",
          scenes: nextScenes,
          parts: nextParts,
          thumbnail_url: thumbnail ?? fresh.record.thumbnail_url ?? undefined,
      });

      rememberLastProject(projectId);
      lastSavedScriptKeyRef.current = JSON.stringify(nextPlan.scenes);
      lastComposeAutosaveKeyRef.current = [
        durableScene.id,
        sourceMode,
        durableScene.kind ?? "",
        durableScene.audioUrl ?? "",
        durableScene.mediaUrl ?? "",
        durableScene.backgroundUrl ?? "",
        (durableScene.narrationText ?? "").slice(0, 120),
        String(durableScene.elements?.length ?? 0),
        String(durableScene.durationMs ?? 0),
      ].join("|");

      // Soft-update stitch list in cache (no invalidate → no remount).
      qc.setQueryData(["project", projectId], (prev: unknown) => {
        if (!prev || typeof prev !== "object") return prev;
        return {
          ...(prev as Record<string, unknown>),
          scenes: nextScenes,
          parts: nextParts,
          updated_at: now,
        };
      });

      if (keepDraft) {
        // Bind id for future updates without wiping the form. Avoid redundant setState.
        if (editingSceneId !== durableScene.id) {
          setEditingSceneId(durableScene.id);
        }
      } else {
        setSelectedPartId(activePartId);
        setPartScriptPlan(nextPlan);
        setPartScriptSaveStatus("saved");
        void qc.invalidateQueries({ queryKey: ["projects"] });
        setEditingSceneId(null);
        resetSceneDraft();
      }
      return true;
    } catch (e: unknown) {
      if (!keepDraft) setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (!keepDraft) setSaving(false);
    }
  }

  // Persist to this Mac in the background — never clears or remounts the compose form.
  useEffect(() => {
    if (!composeSceneSaveReady || !composeAutosaveKey) return;
    if (composeAutosaveKey === lastComposeAutosaveKeyRef.current) return;
    if (saving) return;

    if (composeAutosaveTimerRef.current) {
      clearTimeout(composeAutosaveTimerRef.current);
    }
    composeAutosaveTimerRef.current = setTimeout(() => {
      // Status chip only — do not lock inputs.
      setComposeAutosaveStatus("saving");
      void handleSaveScene({ keepDraft: true }).then((ok) => {
        setComposeAutosaveStatus(ok ? "saved" : "error");
      });
    }, 1500);

    return () => {
      if (composeAutosaveTimerRef.current) {
        clearTimeout(composeAutosaveTimerRef.current);
        composeAutosaveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire when draft becomes durable-ready
  }, [composeSceneSaveReady, composeAutosaveKey, saving]);

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto flex max-w-[1600px] gap-0 px-4 py-8 xl:px-6">
        <div className="min-w-0 flex-1 pr-0 lg:pr-6">
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-bold">
            {project?.title?.trim() || (projectId ? "Episode" : "Compose")}
          </h1>
          <p className="text-sm text-muted-foreground sm:text-right">
            Part:{" "}
            <span className="font-medium text-foreground">
              {partTitle.trim() || "Unnamed part"}
            </span>
            {activePartId ? (
              <span className="text-primary"> · editing saved part</span>
            ) : null}
            {" · "}
            {activeComposeScenes.length} scene
            {activeComposeScenes.length === 1 ? "" : "s"}
          </p>
        </div>

        {projectId && projectLoading && (
          <div className="mb-4 flex items-center gap-2 rounded-md border bg-muted/30 px-4 py-2 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" /> Loading episode…
          </div>
        )}
        {projectId && projectError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {(projectError as Error).message}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {editingSceneId && (
          <div className="mb-4 rounded-md border border-primary/40 bg-primary/5 px-4 py-2 text-sm">
            Working on a saved scene — your edits auto-save to this Mac in the background.
            The form stays open so you can keep editing.
          </div>
        )}

        {!projectId && (
          <div className="mb-6 rounded-lg border bg-card p-6 text-sm text-muted-foreground">
            Open a part from an episode on{" "}
            <Link to="/courses" className="font-medium text-primary hover:underline">
              My Courses
            </Link>{" "}
            to start composing.
          </div>
        )}

        {projectId && (
        <>
        <div className="mb-6 inline-flex flex-wrap rounded-lg border p-1">
          <button
            type="button"
            onClick={() => switchSourceMode("script")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              sourceMode === "script"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Script
          </button>
          <button
            type="button"
            onClick={() => switchSourceMode("upload")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              sourceMode === "upload"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Upload image
          </button>
          <button
            type="button"
            onClick={() => switchSourceMode("code")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              sourceMode === "code"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Coding
          </button>
          <button
            type="button"
            onClick={() => switchSourceMode("question")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              sourceMode === "question"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Questions
          </button>
          <button
            type="button"
            onClick={() => switchSourceMode("template")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              sourceMode === "template"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Templates
          </button>
          <button
            type="button"
            onClick={() => switchSourceMode("recording2")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              sourceMode === "recording2"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Screen recording 2
          </button>
          <button
            type="button"
            onClick={() => switchSourceMode("clip")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              sourceMode === "clip"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Video clip
          </button>
        </div>

        <ComposeStepsAccordion
          sourceMode={sourceMode}
          openSteps={openSteps}
          onOpenSteps={setOpenSteps}
          draft={draft}
          codeDraft={codeDraft}
          questionDraft={questionDraft}
          templateDraft={templateDraft}
          recordingDraft={recordingDraft}
          uploadDataUrl={uploadDataUrl}
          onUploadChange={handleUploadChange}
          partScriptPlan={partScriptPlan}
          onPartScriptPlanChange={handlePartScriptPlanChange}
          scriptSceneCompletions={scriptSceneCompletions}
          savingPartScript={savingPartScript}
          partScriptSaveStatus={partScriptSaveStatus}
          projectId={projectId}
          selectedPartId={selectedPartId}
          onGoToScriptScene={handleGoToScriptScene}
          useDirectImagePrompt={useDirectImagePrompt}
          onUseDirectImagePrompt={setUseDirectImagePrompt}
          directImagePrompt={directImagePrompt}
          onDirectImagePrompt={setDirectImagePrompt}
          lastImagePrompt={lastImagePrompt}
          generatingImage={generatingImage}
          segmentingLayers={segmentingLayers}
          onAutoLayers={handleAutoLayers}
          generatingTts={generatingTts}
          saving={saving}
          showPreview={showPreview}
          canSaveScene={canSaveScene}
          sceneSaveStatus={composeAutosaveStatus}
          selectedCropId={selectedCropId}
          onSelectCrop={setSelectedCropId}
          previewScene={previewScene}
          imageStatus={imageStatus}
          codeStatus={codeStatus}
          questionStatus={questionStatus}
          templateStatus={templateStatus}
          recordingStatus={recordingStatus}
          onDraftScript={(script) => setDraft((d) => ({ ...d, script }))}
          onCodeDraft={(fn) => setCodeDraft(fn)}
          onQuestionDraft={(fn) => setQuestionDraft(fn)}
          onTemplateDraft={(fn) => setTemplateDraft(fn)}
          onRecordingDraft={(fn) => setRecordingDraft(fn)}
          onGenerateImage={handleGenerateImage}
          onUploadNarration={handleUploadNarration}
          onCodeUploadNarration={handleCodeUploadNarration}
          onQuestionUploadNarration={handleQuestionUploadNarration}
          onTemplateUploadNarration={handleTemplateUploadNarration}
          onRecordingUploadNarration={handleRecordingUploadNarration}
          onGenerateTts={handleGenerateTts}
          onCodeTts={handleCodeTts}
          onQuestionTts={handleQuestionTts}
          onTemplateTts={handleTemplateTts}
          onRecordingTts={handleRecordingTts}
          extractingClipAudio={extractingClipAudio}
          onClipVideoUploaded={handleClipVideoUploaded}
          processingRecording2={processingRecording2}
          recording2PhraseBusyIndex={recording2PhraseBusyIndex}
          onRecording2VideoUploaded={handleRecording2VideoUploaded}
          onRecording2RegenerateVoice={handleRecording2RegenerateVoice}
          onRecording2GeneratePhrase={handleRecording2GeneratePhrase}
          onRecording2GenerateAll={handleRecording2GenerateAll}
          onRecording2AssembleVoice={handleRecording2AssembleVoice}
          recording2Voice={recording2Voice}
          onRecording2Voice={setRecording2Voice}
          onPrepareCodeTypingSilent={handlePrepareCodeTypingSilent}
          preparingCodeTyping={preparingCodeTyping}
          loadingFixedPresetId={loadingFixedPresetId}
          onAddFixedTemplate={handleAddFixedTemplateScene}
          questionPaste={questionPaste}
          onQuestionPaste={setQuestionPaste}
          parsingQuestion={parsingQuestion}
          onParseQuestion={handleParseQuestion}
          generatingMarkTts={generatingMarkTts}
          onGenerateMarkTts={handleGenerateMarkTts}
          onUseDefaultMarkTts={handleUseDefaultMarkTts}
          generatingIntroTts={generatingIntroTts}
          onGenerateIntroTts={handleGenerateIntroTts}
          onUseDefaultIntroTts={handleUseDefaultIntroTts}
          onAddCrop={addCrop}
          onRemoveCrop={removeCrop}
          onAnnotateCrop={(id) => setAnnotateCropId(id)}
          onAddPlacement={addPlacement}
          onUpdatePlacement={updatePlacement}
          onRemovePlacement={(id) =>
            setDraft((d) => ({
              ...d,
              placements: d.placements.filter((p) => p.id !== id),
            }))
          }
          onDuration={(ms) => setDraft((d) => ({ ...d, durationMs: ms }))}
          onPreview={() => setShowPreview(true)}
          onSave={() => void handleSaveScene({ keepDraft: true })}
          onQuestionKind={handleQuestionKind}
          editingScene={!!editingSceneId}
          backgroundPreset={backgroundPreset}
          onBackgroundPreset={setBackgroundPreset}
          sceneBackground={sceneBackground}
        />
        <CropAnnotateDialog
          crop={draft.crops.find((c) => c.id === annotateCropId) ?? null}
          open={!!annotateCropId}
          onOpenChange={(open) => {
            if (!open) setAnnotateCropId(null);
          }}
          onSave={updateCropImage}
        />
        </>
        )}
        </div>

        <aside className="hidden w-[20%] min-w-[220px] shrink-0 border-l pl-4 lg:block">
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
            <ComposeProjectPanel
              projectId={projectId}
              project={project ?? undefined}
              partTitle={partTitle}
              onPartTitleChange={setPartTitle}
              partScript={partScriptPlanToText(partScriptPlan)}
              partScriptPlan={partScriptPlan}
              onPartScriptPlanChange={handlePartScriptPlanChange}
              onPartScriptPlanSynced={handlePartScriptPlanSynced}
              selectedPartId={selectedPartId}
              onSelectPart={setSelectedPartId}
              onStitchStateChange={setStitchActive}
              onPartSaved={handlePartSaved}
              onLoadPartForEdit={handleLoadPartForEdit}
              onEditScene={handleEditScene}
              onClearEditScene={resetSceneDraft}
              editingSceneId={editingSceneId}
            />
          </div>
        </aside>
      </div>

      <div className="border-t px-4 py-4 lg:hidden">
        <ComposeProjectPanel
          projectId={projectId}
          project={project ?? undefined}
          partTitle={partTitle}
          onPartTitleChange={setPartTitle}
          partScript={partScriptPlanToText(partScriptPlan)}
          partScriptPlan={partScriptPlan}
          onPartScriptPlanChange={handlePartScriptPlanChange}
          onPartScriptPlanSynced={handlePartScriptPlanSynced}
          selectedPartId={selectedPartId}
          onSelectPart={setSelectedPartId}
          onStitchStateChange={setStitchActive}
          onPartSaved={handlePartSaved}
          onLoadPartForEdit={handleLoadPartForEdit}
          onEditScene={handleEditScene}
          onClearEditScene={resetSceneDraft}
          editingSceneId={editingSceneId}
        />
      </div>
    </div>
  );
}
