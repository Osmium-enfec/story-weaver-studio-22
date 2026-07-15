import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw, Layers } from "lucide-react";
import { NavBar } from "@/components/NavBar";
import { ComposeProjectPanel } from "@/components/compose/ComposeProjectPanel";
import { ComposeNamesBar } from "@/components/compose/ComposeNamesBar";
import { ComposeCreateProjectCard } from "@/components/compose/ComposeCreateProjectCard";
import { ComposeStepsAccordion } from "@/components/compose/ComposeStepsAccordion";
import { generateComposeImage } from "@/lib/compose.functions";
import { generateNarration } from "@/lib/explainer.functions";
import { parseQuestionTextFn } from "@/lib/question-parse.functions";
import { parseQuestionTextFallback, type ParsedQuestion } from "@/lib/parse-question-text";
import { getProject, saveProject } from "@/lib/projects.functions";
import { rememberLastProject } from "@/lib/compose-last-project";
import { getProjectParts, defaultPartTitle } from "@/lib/project-parts";
import {
  composeCodeDraftToScene,
  composeDraftToScene,
  composeQuestionDraftToScene,
  emptyComposeCodeDraft,
  emptyComposeDraft,
  emptyComposeQuestionDraft,
  sceneSourceMode,
  sceneToCodeDraft,
  sceneToComposeDraft,
  sceneToQuestionDraft,
  stripSceneStitchMetadata,
  type ComposeCodeDraft,
  type ComposeCrop,
  type ComposeDraft,
  type ComposeQuestionDraft,
  type ComposeSourceMode,
} from "@/lib/compose-scene";
import type { Scene } from "@/components/VideoPlayer";
import type { ProjectPart } from "@/lib/project-parts";
import { probeAudioDurationMs } from "@/lib/audio-duration";
import type { QuestionKind } from "@/lib/compose-scene";
import {
  buildQuestionNarration,
  parseCorrectLetters,
  QUESTION_MARK_SCREEN_TEXT_DEFAULT,
  QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
} from "@/lib/question-scene-layout";
import {
  ensureQuestionMarkDefaultTts,
  generateQuestionMarkTts,
} from "@/lib/question-mark-default.functions";
import {
  ensureQuestionIntroDefaultTts,
  generateQuestionIntroTts,
} from "@/lib/question-intro-default.functions";
import {
  backgroundFromPreset,
  type ComposeBackgroundPreset,
} from "@/lib/compose-background";
import type { SceneBackground } from "@/lib/scene-background";

export const Route = createFileRoute("/_authenticated/compose")({
  validateSearch: (s: Record<string, unknown>) => ({
    project: typeof s.project === "string" ? s.project : undefined,
  }),
  head: () => ({ meta: [{ title: "Compose Scene — Explainer Studio" }] }),
  component: ComposePage,
});

function ComposePage() {
  const { project: projectId } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const runImage = useServerFn(generateComposeImage);
  const runTts = useServerFn(generateNarration);
  const runParseQuestion = useServerFn(parseQuestionTextFn);
  const runEnsureMarkDefault = useServerFn(ensureQuestionMarkDefaultTts);
  const runGenerateMarkTts = useServerFn(generateQuestionMarkTts);
  const runEnsureIntroDefault = useServerFn(ensureQuestionIntroDefaultTts);
  const runGenerateIntroTts = useServerFn(generateQuestionIntroTts);
  const runGetProject = useServerFn(getProject);
  const runSave = useServerFn(saveProject);

  const { data: project, isLoading: projectLoading, error: projectError } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const timeoutMs = 25_000;
      const result = await Promise.race([
        runGetProject({ data: { id: projectId! } }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Project load timed out. Try opening from Compose sidebar.")), timeoutMs),
        ),
      ]);
      return result;
    },
    enabled: !!projectId,
    retry: 1,
    staleTime: 10_000,
  });


  const [draft, setDraft] = useState<ComposeDraft>(emptyComposeDraft);
  const [codeDraft, setCodeDraft] = useState<ComposeCodeDraft>(emptyComposeCodeDraft);
  const [questionDraft, setQuestionDraft] = useState<ComposeQuestionDraft>(
    emptyComposeQuestionDraft(),
  );
  const [questionPaste, setQuestionPaste] = useState("");
  const [parsingQuestion, setParsingQuestion] = useState(false);
  const [generatingMarkTts, setGeneratingMarkTts] = useState(false);
  const [generatingIntroTts, setGeneratingIntroTts] = useState(false);
  const [markDefaultLoaded, setMarkDefaultLoaded] = useState(false);
  const [introDefaultLoaded, setIntroDefaultLoaded] = useState(false);
  const [selectedCropId, setSelectedCropId] = useState<string | null>(null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [generatingTts, setGeneratingTts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [openSteps, setOpenSteps] = useState<string[]>(["image"]);
  const [projectTitle, setProjectTitle] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [lastImagePrompt, setLastImagePrompt] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<ComposeSourceMode>("upload");
  const [useDirectImagePrompt, setUseDirectImagePrompt] = useState(true);
  const [directImagePrompt, setDirectImagePrompt] = useState("");
  const [uploadDataUrl, setUploadDataUrl] = useState<string | null>(null);
  const [partTitle, setPartTitle] = useState("Part 1");
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [stitchActive, setStitchActive] = useState(false);
  const [backgroundPreset, setBackgroundPreset] =
    useState<ComposeBackgroundPreset>("video-loop");
  const sceneBackground: SceneBackground = useMemo(
    () => backgroundFromPreset(backgroundPreset),
    [backgroundPreset],
  );

  useEffect(() => {
    if (project?.title) setProjectTitle(project.title);
  }, [project?.title]);

  useEffect(() => {
    if (!projectId || !project || partTitle.trim() || selectedPartId) return;
    const scenes = (project.scenes as unknown[]) ?? [];
    if (scenes.length > 0) {
      setPartTitle(defaultPartTitle(getProjectParts(project)));
    }
  }, [projectId, project, partTitle, selectedPartId]);

  const previewScene = useMemo(() => {
    if (sourceMode === "code") return composeCodeDraftToScene(codeDraft);
    if (sourceMode === "question") return composeQuestionDraftToScene(questionDraft);
    return composeDraftToScene(draft);
  }, [sourceMode, codeDraft, questionDraft, draft]);

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

  const codeStatus = useMemo(
    () => ({
      setup: codeDraft.code.trim().length >= 3,
      tts: codeDraft.ready && !!codeDraft.audioUrl,
      preview: showPreview,
      saveReady: codeDraft.ready && !!codeDraft.audioUrl,
    }),
    [codeDraft, showPreview],
  );

  const questionStatus = useMemo(() => {
    const optionsOk = questionDraft.options.every((o) => o.trim().length > 0);
    const markTextOk = questionDraft.markText.trim().length >= 2;
    const introTextOk = questionDraft.introText.trim().length >= 2;
    const markAudioOk =
      !!questionDraft.markAudioUrl &&
      questionDraft.markAudioForText.trim() === questionDraft.markText.trim();
    const introAudioOk =
      !!questionDraft.introAudioUrl &&
      questionDraft.introAudioForText.trim() === questionDraft.introText.trim();
    const setup =
      questionDraft.question.trim().length >= 3 &&
      optionsOk &&
      markTextOk &&
      markAudioOk &&
      introTextOk &&
      introAudioOk;
    return {
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
        const res = await runEnsureMarkDefault();
        if (cancelled) return;
        setQuestionDraft((d) => ({
          ...d,
          markText: d.markText.trim() || res.text,
          markAudioUrl: d.markAudioUrl ?? res.audioUrl,
          markAudioForText: d.markAudioForText || res.text,
        }));
        setMarkDefaultLoaded(true);
      } catch {
        if (!cancelled) setMarkDefaultLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceMode, markDefaultLoaded, questionDraft.markAudioUrl]);

  useEffect(() => {
    if (sourceMode !== "question" || introDefaultLoaded || questionDraft.introAudioUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await runEnsureIntroDefault();
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
  }, [sourceMode, introDefaultLoaded, questionDraft.introAudioUrl]);

  const canSaveScene = !!projectId && !!partTitle.trim();

  const sceneTitle =
    sourceMode === "code"
      ? codeDraft.title
      : sourceMode === "question"
        ? questionDraft.title
        : (draft.title ?? "");

  function setSceneTitle(v: string) {
    if (sourceMode === "code") {
      setCodeDraft((d) => ({ ...d, title: v }));
    } else if (sourceMode === "question") {
      setQuestionDraft((d) => ({ ...d, title: v }));
    } else {
      setDraft((d) => ({ ...d, title: v }));
    }
  }

  async function handleProjectTitleSave() {
    if (!projectId || !project) return;
    const title = projectTitle.trim() || project.title;
    if (title === project.title) return;
    try {
      await runSave({
        data: {
          id: projectId,
          title,
          script: project.script ?? undefined,
          audio_mode: project.audio_mode as "tts" | "upload",
          scenes: (project.scenes as unknown[]) ?? [],
          parts: getProjectParts(project),
          thumbnail_url: project.thumbnail_url ?? undefined,
        },
      });
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handlePartTitleSave() {
    if (!projectId || !project || !selectedPartId) return;
    const parts = getProjectParts(project);
    const existing = parts.find((p) => p.id === selectedPartId);
    if (!existing) return;
    const title = partTitle.trim() || existing.title;
    if (title === existing.title) return;
    const next = parts.map((p) =>
      p.id === selectedPartId
        ? { ...p, title, updated_at: new Date().toISOString() }
        : p,
    );
    try {
      await runSave({
        data: {
          id: projectId,
          title: project.title,
          script: project.script ?? undefined,
          audio_mode: project.audio_mode as "tts" | "upload",
          scenes: (project.scenes as unknown[]) ?? [],
          parts: next,
          thumbnail_url: project.thumbnail_url ?? undefined,
        },
      });
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCreateProject() {
    const title = projectTitle.trim();
    const part = partTitle.trim();
    if (!title || !part) {
      setError("Enter both project name and part name.");
      return;
    }
    setCreatingProject(true);
    setError(null);
    try {
      const res = await runSave({
        data: {
          title,
          audio_mode: "tts",
          scenes: [],
          parts: [],
        },
      });
      rememberLastProject(res.id);
      await qc.invalidateQueries({ queryKey: ["projects"] });
      navigate({ to: "/compose", search: { project: res.id }, replace: true });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingProject(false);
    }
  }

  function switchSourceMode(mode: ComposeSourceMode) {
    setSourceMode(mode);
    setDraft(emptyComposeDraft());
    setCodeDraft(emptyComposeCodeDraft());
    setQuestionDraft(emptyComposeQuestionDraft());
    setQuestionPaste("");
    setSelectedCropId(null);
    setShowPreview(false);
    setError(null);
    setLastImagePrompt(null);
    setUploadDataUrl(null);
    setOpenSteps(mode === "code" || mode === "question" ? ["setup"] : ["image"]);
  }

  function handleQuestionKind(kind: QuestionKind) {
    setQuestionDraft((d) => ({
      ...emptyComposeQuestionDraft(kind),
      script: d.script,
      question: d.question,
      subtitle: d.subtitle,
      options: d.options,
      correctInput: d.correctInput,
      markText: d.markText,
      markGapSec: d.markGapSec,
      markCountdownSec: d.markCountdownSec,
      markAudioUrl: d.markAudioUrl,
      markAudioForText: d.markAudioForText,
      introText: d.introText,
      introGapSec: d.introGapSec,
      introAudioUrl: d.introAudioUrl,
      introAudioForText: d.introAudioForText,
      introDurationMs: d.introDurationMs,
    }));
  }

  async function handleUseDefaultIntroTts() {
    setError(null);
    setGeneratingIntroTts(true);
    setShowPreview(false);
    try {
      const res = await runEnsureIntroDefault();
      const probed = await probeAudioDurationMs(res.audioUrl);
      setQuestionDraft((d) => ({
        ...d,
        introText: QUESTION_INTRO_SCREEN_TEXT_DEFAULT,
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
      const res = await runGenerateIntroTts({ data: { text } });
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
      kind: parsed.kind,
      question: parsed.question,
      options: parsed.options,
      ready: false,
    }));
  }

  async function handleUseDefaultMarkTts() {
    setError(null);
    setGeneratingMarkTts(true);
    try {
      const res = await runEnsureMarkDefault();
      setQuestionDraft((d) => ({
        ...d,
        markText: QUESTION_MARK_SCREEN_TEXT_DEFAULT,
        markGapSec: 2,
        markCountdownSec: 3,
        markAudioUrl: res.audioUrl,
        markAudioForText: res.text,
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
      const res = await runGenerateMarkTts({ data: { text } });
      setQuestionDraft((d) => ({
        ...d,
        markText: res.text,
        markAudioUrl: res.audioUrl,
        markAudioForText: res.text,
        ready: false,
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingMarkTts(false);
    }
  }

  async function handleParseQuestion() {
    const raw = questionPaste.trim();
    if (raw.length < 10) {
      setError("Paste a question with options A–D first.");
      return;
    }
    setError(null);
    setParsingQuestion(true);
    setShowPreview(false);
    try {
      const local = parseQuestionTextFallback(raw, questionDraft.kind);
      if (local) {
        applyParsedQuestion(local);
        return;
      }
      const parsed = await runParseQuestion({
        data: { text: raw, kind: questionDraft.kind },
      });
      applyParsedQuestion(parsed);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setParsingQuestion(false);
    }
  }

  async function handleQuestionTts() {
    if (!questionStatus.setup) {
      setError("Fill in the question and all four options first.");
      return;
    }
    const q = questionDraft;
    const script =
      q.script.trim() ||
      buildQuestionNarration({
        kind: q.kind,
        question: q.question.trim(),
        subtitle: q.subtitle.trim() || "Question",
        options: q.options,
        correct: parseCorrectLetters(q.correctInput, q.kind),
      });

    setError(null);
    setGeneratingTts(true);
    setShowPreview(false);
    try {
      const tts = await runTts({ data: { text: script } });
      const durationMs = (await probeAudioDurationMs(tts.audioUrl)) ?? 8000;
      const title = q.title.trim() || q.question.trim().slice(0, 48) || "Question";
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
      const img = await runImage({
        data: {
          script: script || undefined,
          ...(directPrompt ? { imagePrompt: directPrompt } : {}),
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingImage(false);
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
      const tts = await runTts({ data: { text: script } });
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

  async function handleCodeTts() {
    const script = codeDraft.script.trim();
    const code = codeDraft.code.trim();
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
      const tts = await runTts({ data: { text: script } });
      const durationMs = (await probeAudioDurationMs(tts.audioUrl)) ?? 8000;
      setCodeDraft((d) => ({
        ...d,
        script,
        code,
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

  function updatePlacement(id: string, patch: { sfxUrl?: string | null }) {
    setDraft((d) => ({
      ...d,
      placements: d.placements.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p };
        if (patch.sfxUrl === null || patch.sfxUrl === undefined) {
          delete next.sfxUrl;
        } else {
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
    setQuestionPaste("");
    setEditingSceneId(null);
  }

  async function handleLoadPartForEdit(part: ProjectPart) {
    if (!projectId || !project) return;
    const currentScenes = (project.scenes as Scene[] | undefined) ?? [];
    if (
      currentScenes.length > 0 &&
      !confirm(
        `Load "${part.title}" for editing? Scenes in the current part list will be replaced.`,
      )
    ) {
      return;
    }
    const editableScenes = part.scenes.map(stripSceneStitchMetadata);
    try {
      await runSave({
        data: {
          id: projectId,
          title: project.title,
          script: project.script ?? undefined,
          audio_mode: project.audio_mode as "tts" | "upload",
          scenes: editableScenes,
          parts: getProjectParts(project),
          thumbnail_url: project.thumbnail_url ?? undefined,
        },
      });
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      setSelectedPartId(part.id);
      setPartTitle(part.title);
      setStitchActive(false);
      setEditingSceneId(null);
      resetSceneDraft();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleEditScene(scene: Scene, _index: number) {
    const mode = sceneSourceMode(scene);
    switchSourceMode(mode);
    if (mode === "code") {
      const d = sceneToCodeDraft(scene);
      if (d) setCodeDraft(d);
    } else if (mode === "question") {
      const d = sceneToQuestionDraft(scene);
      if (d) setQuestionDraft(d);
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

  async function startNewPart() {
    if (!projectId || !project) {
      setError("Create a project first.");
      return;
    }
    const currentScenes = (project.scenes as unknown[]) ?? [];
    if (
      currentScenes.length > 0 &&
      !confirm(
        `Start a new part? ${currentScenes.length} scene(s) in "${partTitle || "this part"}" will be cleared.`,
      )
    ) {
      return;
    }
    const parts = getProjectParts(project);
    const nextPartTitle = defaultPartTitle(parts);
    try {
      await runSave({
        data: {
          id: projectId,
          title: project.title,
          script: project.script ?? undefined,
          audio_mode: project.audio_mode as "tts" | "upload",
          scenes: [],
          parts,
          thumbnail_url: project.thumbnail_url ?? undefined,
        },
      });
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      resetSceneDraft();
      setPartTitle(nextPartTitle);
      setSelectedPartId(null);
      setStitchActive(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function startNewProject() {
    if (
      !confirm(
        "Start a new project? You will name the project and first part on the next screen.",
      )
    ) {
      return;
    }
    navigate({ to: "/compose", search: {} });
    resetSceneDraft();
    setProjectTitle("");
    setPartTitle("Part 1");
    setSelectedPartId(null);
    setStitchActive(false);
  }

  function handlePartSaved(nextPartTitle: string, opts?: { updated?: boolean }) {
    setPartTitle(nextPartTitle);
    if (!opts?.updated) {
      setSelectedPartId(null);
      resetSceneDraft();
    } else {
      setEditingSceneId(null);
    }
    setStitchActive(false);
  }

  async function handleSaveScene() {
    const isCode = sourceMode === "code";
    const isQuestion = sourceMode === "question";
    const scene = isCode
      ? composeCodeDraftToScene(codeDraft, editingSceneId ?? undefined)
      : isQuestion
        ? composeQuestionDraftToScene(questionDraft, editingSceneId ?? undefined)
        : composeDraftToScene(draft, editingSceneId ?? undefined);

    if (!scene) {
      setError(
        isCode
          ? "Generate TTS for your code scene before saving."
          : isQuestion
            ? "Generate TTS for your question scene before saving."
            : "Generate audio and add at least one timeline placement before saving.",
      );
      return;
    }
    if (!isCode && !isQuestion && draft.placements.length === 0) {
      setError("Add at least one crop on the timeline before saving.");
      return;
    }

    if (!projectId || !project) {
      setError("Create a project and name your part first.");
      return;
    }
    if (!partTitle.trim()) {
      setError("Name your part at the top before saving scenes.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const existingScenes = ((project.scenes as Scene[] | undefined) ?? []).slice();
      const existingParts = getProjectParts(project);
      const script =
        project.script ??
        (isCode ? codeDraft.script : isQuestion ? questionDraft.script : draft.script);

      const thumbnail =
        isCode || isQuestion
          ? undefined
          : draft.compositeUrl ?? scene.elements?.[0]?.mediaUrl;

      let nextScenes: Scene[];
      if (editingSceneId != null) {
        const idx = existingScenes.findIndex((s) => s.id === editingSceneId);
        if (idx >= 0) {
          nextScenes = existingScenes.map((s, i) => (i === idx ? scene : s));
        } else {
          nextScenes = [...existingScenes, scene];
        }
      } else {
        nextScenes = [...existingScenes, scene];
      }

      await runSave({
        data: {
          id: projectId,
          title: project.title,
          script,
          audio_mode: "tts",
          scenes: nextScenes,
          parts: existingParts,
          thumbnail_url: thumbnail ?? project.thumbnail_url ?? undefined,
        },
      });

      await qc.invalidateQueries({ queryKey: ["projects"] });
      rememberLastProject(projectId);
      await qc.invalidateQueries({ queryKey: ["project", projectId] });

      setEditingSceneId(null);
      resetSceneDraft();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto flex max-w-[1600px] gap-0 px-4 py-8 xl:px-6">
        <div className="min-w-0 flex-1 pr-0 lg:pr-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Compose scene</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Project → Part → Scenes. Stitch scenes into a part, save it, then start the next part.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={startNewProject}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            >
              New project
            </button>
            {projectId && (
              <button
                type="button"
                onClick={startNewPart}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                <Layers size={14} /> New part
              </button>
            )}
            <button
              type="button"
              onClick={resetSceneDraft}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            >
              <RotateCcw size={14} /> New scene
            </button>
          </div>
        </div>

        {projectId && projectLoading && (
          <div className="mb-4 flex items-center gap-2 rounded-md border bg-muted/30 px-4 py-2 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" /> Loading project scenes…
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
            Editing a saved scene — change it below, then click{" "}
            <span className="font-medium">Update scene in part</span>.
          </div>
        )}

        {!projectId ? (
          <ComposeCreateProjectCard
            projectTitle={projectTitle}
            onProjectTitleChange={setProjectTitle}
            partTitle={partTitle}
            onPartTitleChange={setPartTitle}
            creating={creatingProject}
            onCreate={handleCreateProject}
          />
        ) : (
          <ComposeNamesBar
            projectId={projectId}
            projectTitle={projectTitle}
            onProjectTitleChange={setProjectTitle}
            onProjectTitleSave={handleProjectTitleSave}
            partTitle={partTitle}
            onPartTitleChange={setPartTitle}
            onPartTitleSave={handlePartTitleSave}
            sceneTitle={sceneTitle}
            onSceneTitleChange={setSceneTitle}
          />
        )}

        {projectId && (
        <>
        <div className="mb-6 inline-flex rounded-lg border p-1">
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
            onClick={() => switchSourceMode("text")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${
              sourceMode === "text"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Generate from text
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
            Code typing
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
        </div>

        <ComposeStepsAccordion
          sourceMode={sourceMode}
          openSteps={openSteps}
          onOpenSteps={setOpenSteps}
          draft={draft}
          codeDraft={codeDraft}
          questionDraft={questionDraft}
          uploadDataUrl={uploadDataUrl}
          onUploadChange={handleUploadChange}
          useDirectImagePrompt={useDirectImagePrompt}
          onUseDirectImagePrompt={setUseDirectImagePrompt}
          directImagePrompt={directImagePrompt}
          onDirectImagePrompt={setDirectImagePrompt}
          lastImagePrompt={lastImagePrompt}
          generatingImage={generatingImage}
          generatingTts={generatingTts}
          saving={saving}
          showPreview={showPreview}
          canSaveScene={canSaveScene}
          selectedCropId={selectedCropId}
          onSelectCrop={setSelectedCropId}
          previewScene={previewScene}
          imageStatus={imageStatus}
          codeStatus={codeStatus}
          questionStatus={questionStatus}
          onDraftScript={(script) => setDraft((d) => ({ ...d, script }))}
          onCodeDraft={(fn) => setCodeDraft(fn)}
          onQuestionDraft={(fn) => setQuestionDraft(fn)}
          onGenerateImage={handleGenerateImage}
          onGenerateTts={handleGenerateTts}
          onCodeTts={handleCodeTts}
          onQuestionTts={handleQuestionTts}
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
          onSave={handleSaveScene}
          onQuestionKind={handleQuestionKind}
          editingScene={!!editingSceneId}
          backgroundPreset={backgroundPreset}
          onBackgroundPreset={setBackgroundPreset}
          sceneBackground={sceneBackground}
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
              selectedPartId={selectedPartId}
              onSelectPart={setSelectedPartId}
              onStitchStateChange={setStitchActive}
              onPartSaved={handlePartSaved}
              onLoadPartForEdit={handleLoadPartForEdit}
              onEditScene={handleEditScene}
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
          selectedPartId={selectedPartId}
          onSelectPart={setSelectedPartId}
          onStitchStateChange={setStitchActive}
          onPartSaved={handlePartSaved}
          onLoadPartForEdit={handleLoadPartForEdit}
          onEditScene={handleEditScene}
          editingSceneId={editingSceneId}
        />
      </div>
    </div>
  );
}
