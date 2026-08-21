import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Download,
  Film,
  Loader2,
  Maximize2,
  Music,
  Pencil,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { VideoPlayer, type Scene } from "@/components/VideoPlayer";
import { apiPersistAsset } from "@/lib/compose-api";
import { apiGetProject, apiSaveProject } from "@/lib/projects-api";
import { startNativeExportJob } from "@/lib/native-export-client";
import type { ExportQuality } from "@/lib/ffmpeg-stitcher";
import {
  getProjectParts,
  partThumb,
  type ProjectPart,
} from "@/lib/project-parts";
import { stitchProjectScenes } from "@/lib/stitch-project-scenes";
import { healScenesForExport } from "@/lib/compose-scene";
import { DEFAULT_BACKGROUND } from "@/lib/scene-background";
import {
  DEFAULT_PART_BGM,
  resolvePartBgm,
  type PartBgmConfig,
} from "@/lib/part-bgm";
import {
  DEFAULT_PART_TRANSITION,
  resolvePartTransition,
  syncGapTransitions,
  TRANSITION_EFFECT_OPTIONS,
  TRANSITION_SFX_OPTIONS,
  type PartTransitionConfig,
  type TransitionEffectId,
  type TransitionSfxId,
} from "@/lib/part-transition";
import { persistPartScenesForSave, persistScenesAssetsForSave } from "@/lib/persist-client-asset";
import { stripSceneStitchMetadata } from "@/lib/compose-scene";
import { createClientId } from "@/lib/client-id";
import { getStoredSession } from "@/lib/auth-client";

function newId(): string {
  return createClientId();
}

import type { ProjectRecord } from "@/lib/projects-api";
import type { PartScriptPlan } from "@/lib/part-script";
import {
  composeIdFromScriptSceneId,
  isIncompleteComposeScene,
  partIncompleteSceneSummaries,
  partScenesAllComplete,
  partScriptPlanToText,
  syncScriptPlanWithComposeScenes,
} from "@/lib/part-script";

interface ComposeProjectPanelProps {
  projectId?: string;
  project?: ProjectRecord | null;
  partTitle: string;
  onPartTitleChange: (v: string) => void;
  /** Current Script-tab text; stored on the part when it is saved. */
  partScript?: string;
  /** Structured script plan; preferred over flat partScript when present. */
  partScriptPlan?: PartScriptPlan;
  /** Keep Script tab in lockstep when stitch scenes are reordered/deleted. */
  onPartScriptPlanChange?: (plan: PartScriptPlan) => void;
  /**
   * Update Script plan in React state only (no second save).
   * Used after stitch already persisted plan + scenes together.
   */
  onPartScriptPlanSynced?: (plan: PartScriptPlan) => void;
  selectedPartId: string | null;
  onSelectPart: (id: string | null) => void;
  onStitchStateChange: (active: boolean) => void;
  onPartSaved: (nextPartTitle: string, opts?: { updated?: boolean }) => void;
  onLoadPartForEdit: (part: ProjectPart) => void | Promise<void>;
  onEditScene: (scene: Scene, index: number) => void;
  /** Called when the scene currently being edited is deleted. */
  onClearEditScene?: () => void;
  editingSceneId: string | null;
}

export function ComposeProjectPanel({
  projectId,
  project,
  partTitle,
  partScript,
  partScriptPlan,
  onPartScriptPlanChange,
  onPartScriptPlanSynced,
  selectedPartId,
  onSelectPart,
  onStitchStateChange,
  onPartSaved,
  onEditScene,
  onClearEditScene,
  editingSceneId,
}: ComposeProjectPanelProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [saving, setSaving] = useState(false);
  const [savingPart, setSavingPart] = useState(false);
  const [deletingSceneId, setDeletingSceneId] = useState<string | null>(null);
  const [deletingPartId, setDeletingPartId] = useState<string | null>(null);
  const [stitching, setStitching] = useState(false);
  const [stitchError, setStitchError] = useState<string | null>(null);
  const [stitched, setStitched] = useState<Scene[] | null>(null);
  const [stitchMasterAudio, setStitchMasterAudio] = useState<string | null>(null);
  const [stitchDurationMs, setStitchDurationMs] = useState(0);
  const [showStitchPreview, setShowStitchPreview] = useState(false);
  const [fullPagePreview, setFullPagePreview] = useState(false);

  useEffect(() => {
    if (!fullPagePreview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullPagePreview(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullPagePreview]);
  const [startingExportId, setStartingExportId] = useState<string | null>(null);
  const [exportRunner, setExportRunner] = useState<"server" | "agent">(() => {
    try {
      const v = localStorage.getItem("explainer.exportRunner");
      return v === "agent" ? "agent" : "server";
    } catch {
      return "server";
    }
  });
  const [renamingSceneId, setRenamingSceneId] = useState<string | null>(null);
  const [bgmEnabled, setBgmEnabled] = useState(DEFAULT_PART_BGM.enabled !== false);
  const [bgmVolume, setBgmVolume] = useState(DEFAULT_PART_BGM.volume);
  const [gapTransitions, setGapTransitions] = useState<PartTransitionConfig[]>([]);

  const savedParts = getProjectParts(project ?? undefined);

  const session = getStoredSession();
  const isAdmin = session?.user.isAdmin ?? false;
  const myUserId = session?.user.id ?? null;
  const myEmail = session?.user.email ?? null;

  const visibleParts = useMemo(() => {
    if (isAdmin) return savedParts;
    const normEmail = myEmail?.trim().toLowerCase() ?? null;
    return savedParts.filter((p) => {
      if (myUserId && p.assignedUserId && p.assignedUserId === myUserId) return true;
      if (normEmail && p.assignedUserEmail?.trim().toLowerCase() === normEmail) return true;
      return false;
    });
  }, [isAdmin, savedParts, myUserId, myEmail]);

  const selectedPart = visibleParts.find((p) => p.id === selectedPartId) ?? null;

  // Always edit the selected part's own scenes — never the shared episode buffer.
  const scenes = (
    selectedPartId
      ? (selectedPart?.scenes as Scene[] | undefined)
      : ((project?.scenes as Scene[] | undefined) ?? undefined)
  )?.slice() ?? [];

  const scriptPlanForScenes: PartScriptPlan = useMemo(() => {
    if (partScriptPlan?.scenes?.length) return partScriptPlan;
    return syncScriptPlanWithComposeScenes({ scenes: [] }, scenes);
  }, [partScriptPlan, scenes]);

  const allScenesComplete = useMemo(
    () =>
      scenes.length > 0 && partScenesAllComplete(scriptPlanForScenes, scenes),
    [scriptPlanForScenes, scenes],
  );

  const incompleteSummaries = useMemo(
    () =>
      scenes.length === 0
        ? []
        : partIncompleteSceneSummaries(scriptPlanForScenes, scenes),
    [scriptPlanForScenes, scenes],
  );

  const scriptByComposeId = useMemo(() => {
    const map = new Map<string, (typeof scriptPlanForScenes.scenes)[number]>();
    for (const row of scriptPlanForScenes.scenes) {
      const cid = composeIdFromScriptSceneId(row.id);
      if (cid) map.set(cid, row);
    }
    return map;
  }, [scriptPlanForScenes]);

  const visiblePartIdsKey = useMemo(() => visibleParts.map((p) => p.id).join("|"), [visibleParts]);
  useEffect(() => {
    if (!selectedPartId) {
      if (!isAdmin && visibleParts.length === 1) {
        onSelectPart(visibleParts[0]!.id);
      }
      return;
    }
    if (visibleParts.some((p) => p.id === selectedPartId)) return;
    onSelectPart(visibleParts[0]?.id ?? null);
    setStitched(null);
    setStitchMasterAudio(null);
    setShowStitchPreview(false);
  }, [selectedPartId, visiblePartIdsKey, isAdmin]);

  const partBgmConfig = useMemo((): PartBgmConfig => {
    return {
      url: DEFAULT_PART_BGM.url,
      volume: bgmVolume,
      enabled: bgmEnabled,
    };
  }, [bgmEnabled, bgmVolume]);

  const partBgmForPlayback = useMemo((): PartBgmConfig | null => {
    if (!bgmEnabled) return null;
    return partBgmConfig;
  }, [bgmEnabled, partBgmConfig]);

  const partTransitionDefault = useMemo(
    () => resolvePartTransition(selectedPart?.transition ?? DEFAULT_PART_TRANSITION),
    [selectedPart?.transition],
  );

  // Keep one transition config between every consecutive scene pair.
  useEffect(() => {
    const fromScenes = scenes.slice(0, -1).map((s) => s.outTransition);
    const fromPart = selectedPart?.transitions;
    const seed =
      fromScenes.some(Boolean)
        ? fromScenes.map((t) => resolvePartTransition(t ?? partTransitionDefault))
        : fromPart;
    setGapTransitions(syncGapTransitions(seed, scenes.length, partTransitionDefault));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync when scene ids / count / part change
  }, [
    scenes.map((s) => s.id).join("|"),
    scenes.length,
    selectedPart?.id,
    partTransitionDefault.durationMs,
    partTransitionDefault.effect,
    partTransitionDefault.sfxId,
    partTransitionDefault.sfxVolume,
  ]);

  useEffect(() => {
    if (selectedPart?.bgm) {
      setBgmEnabled(selectedPart.bgm.enabled !== false);
      setBgmVolume(
        typeof selectedPart.bgm.volume === "number"
          ? selectedPart.bgm.volume
          : DEFAULT_PART_BGM.volume,
      );
    } else {
      setBgmEnabled(DEFAULT_PART_BGM.enabled !== false);
      setBgmVolume(DEFAULT_PART_BGM.volume);
    }
  }, [selectedPart?.id]);

  useEffect(() => {
    onStitchStateChange(!!stitched && stitched.length > 0);
  }, [stitched, onStitchStateChange]);

  /** Persist BGM onto the open part so refresh keeps the user's choice. */
  async function persistPartBgm(next: PartBgmConfig) {
    if (!projectId || !selectedPartId || !project) return;
    const existing = savedParts.find((p) => p.id === selectedPartId);
    if (!existing) return;
    const now = new Date().toISOString();
    const updated: ProjectPart = {
      ...existing,
      bgm: next,
      updated_at: now,
    };
    await persistProject({
      parts: savedParts.map((p) => (p.id === selectedPartId ? updated : p)),
    });
  }

  const bgmPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function schedulePersistBgm(nextEnabled: boolean, nextVolume: number) {
    const next: PartBgmConfig = {
      url: DEFAULT_PART_BGM.url,
      volume: nextVolume,
      enabled: nextEnabled,
    };
    if (bgmPersistTimer.current) clearTimeout(bgmPersistTimer.current);
    bgmPersistTimer.current = setTimeout(() => {
      void persistPartBgm(next);
    }, 400);
  }

  async function persistProject(update: {
    scenes?: Scene[];
    parts?: ProjectPart[];
    title?: string;
    allowSceneShrink?: boolean;
  }) {
    if (!projectId || !project) return;
    setSaving(true);
    setStitchError(null);
    try {
      // Re-read from host so another collaborator's part isn't overwritten with a stale copy.
      const fresh = await apiGetProject(projectId);
      const freshParts = getProjectParts(fresh);
      let nextParts = freshParts;

      if (update.parts) {
        const updateIds = new Set(update.parts.map((p) => p.id));
        const isDeletion = freshParts.some((p) => !updateIds.has(p.id));

        if (isDeletion && isAdmin) {
          nextParts = freshParts.filter((p) => updateIds.has(p.id));
        } else if (selectedPartId) {
          const incomingSelected = update.parts.find((p) => p.id === selectedPartId);
          nextParts = freshParts.map((p) =>
            p.id === selectedPartId && incomingSelected
              ? { ...incomingSelected, updated_at: new Date().toISOString() }
              : p,
          );
        }

        for (const p of update.parts) {
          if (!nextParts.some((x) => x.id === p.id)) {
            nextParts = [...nextParts, p];
          }
        }
      }

      await apiSaveProject({
          id: projectId,
          title: update.title ?? fresh.title,
          script: fresh.script ?? undefined,
          audio_mode: fresh.audio_mode as "tts" | "upload",
          scenes: update.scenes ?? (selectedPart?.scenes as Scene[] | undefined) ?? [],
          parts: nextParts,
          thumbnail_url: fresh.thumbnail_url ?? undefined,
          allow_scene_shrink: update.allowSceneShrink === true,
      });
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
    } finally {
      setSaving(false);
    }
  }

  async function persistScenes(
    next: Scene[],
    opts?: { allowSceneShrink?: boolean },
  ) {
    if (!projectId) return;
    // Keep Script tab identical to stitch list (count + order).
    const nextPlan = syncScriptPlanWithComposeScenes(
      partScriptPlan ?? { scenes: [] },
      next,
    );
    // State-only sync — avoid a second save that can race and resurrect deleted rows.
    if (onPartScriptPlanSynced) {
      onPartScriptPlanSynced(nextPlan);
    } else {
      onPartScriptPlanChange?.(nextPlan);
    }

    const allowShrink =
      opts?.allowSceneShrink === true || next.length < scenes.length;

    if (!selectedPartId) {
      await persistProject({
        scenes: next,
        allowSceneShrink: allowShrink,
      });
      setStitched(null);
      setStitchMasterAudio(null);
      return;
    }
    const fresh = await apiGetProject(projectId);
    const freshParts = getProjectParts(fresh);
    const now = new Date().toISOString();
    const nextParts = freshParts.map((p) =>
      p.id === selectedPartId
        ? {
            ...p,
            scenes: next,
            scriptScenes: nextPlan.scenes,
            script: partScriptPlanToText(nextPlan),
            updated_at: now,
          }
        : p,
    );
    await persistProject({
      scenes: next,
      parts: nextParts,
      allowSceneShrink: allowShrink,
    });
    setStitched(null);
    setStitchMasterAudio(null);
  }

  function moveScene(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= scenes.length) return;
    const synced = syncGapTransitions(gapTransitions, scenes.length, partTransitionDefault);
    const withGaps = scenes.map((s, i) =>
      i < synced.length ? { ...s, outTransition: synced[i]! } : { ...s, outTransition: undefined },
    );
    const next = [...withGaps];
    [next[index], next[j]] = [next[j]!, next[index]!];
    void persistScenes(next);
  }

  async function renameScene(index: number, subtitle: string) {
    const next = scenes.map((s, i) =>
      i === index ? { ...s, subtitle: subtitle.trim() || `Scene ${i + 1}` } : s,
    );
    await persistScenes(next);
    setRenamingSceneId(null);
  }

  async function deleteScene(index: number) {
    const target = scenes[index];
    if (!target) return;
    const label = target.subtitle ?? target.narrationText ?? `Scene ${index + 1}`;
    if (!confirm(`Delete “${label}”? This cannot be undone.`)) return;

    const sceneKey = target.id || `idx-${index}`;
    setDeletingSceneId(sceneKey);
    try {
      const synced = syncGapTransitions(gapTransitions, scenes.length, partTransitionDefault);
      const withGaps = scenes.map((s, i) =>
        i < synced.length ? { ...s, outTransition: synced[i]! } : { ...s, outTransition: undefined },
      );
      const next = withGaps.filter((_, i) => i !== index).map((s, i, arr) =>
        i === arr.length - 1 ? { ...s, outTransition: undefined } : s,
      );
      await persistScenes(next, { allowSceneShrink: true });
      if (target.id && editingSceneId === target.id) {
        onClearEditScene?.();
      }
    } finally {
      setDeletingSceneId(null);
    }
  }

  function updateGapTransition(gapIndex: number, patch: Partial<PartTransitionConfig>) {
    setGapTransitions((prev) => {
      const next = syncGapTransitions(prev, scenes.length, partTransitionDefault);
      const cur = resolvePartTransition(next[gapIndex] ?? partTransitionDefault);
      next[gapIndex] = resolvePartTransition({ ...cur, ...patch });
      return next;
    });
    setStitched(null);
    setStitchMasterAudio(null);
  }

  async function persistGapTransitionsToScenes(
    gaps: PartTransitionConfig[],
  ): Promise<Scene[]> {
    const synced = syncGapTransitions(gaps, scenes.length, partTransitionDefault);
    return scenes.map((s, i) =>
      i < synced.length ? { ...s, outTransition: synced[i]! } : { ...s, outTransition: undefined },
    );
  }

  async function handleStitch() {
    if (scenes.length === 0) return;
    if (!projectId) {
      setStitchError("Open a project before stitching.");
      return;
    }
    if (!allScenesComplete) {
      const lines =
        incompleteSummaries.length > 0
          ? incompleteSummaries.join("\n")
          : "Finish every scene before stitching.";
      setStitchError(
        `Cannot stitch until every scene is 100% complete:\n${lines}`,
      );
      setShowStitchPreview(false);
      setStitched(null);
      setStitchMasterAudio(null);
      return;
    }
    setStitching(true);
    setStitchError(null);
    try {
      const syncedGaps = syncGapTransitions(
        gapTransitions,
        scenes.length,
        partTransitionDefault,
      );
      const scenesWithGaps = await persistGapTransitionsToScenes(syncedGaps);
      // Durably save any leftover blob/data media from older scenes (no TTS regen).
      const durableScenes = await persistScenesAssetsForSave(
        scenesWithGaps,
        projectId,
        (input) => apiPersistAsset(input),
      );
      const mediaChanged = durableScenes.some((s, i) => {
        const prev = scenesWithGaps[i]!;
        return (
          s.audioUrl !== prev.audioUrl ||
          s.mediaUrl !== prev.mediaUrl ||
          s.questionMarkAudioUrl !== prev.questionMarkAudioUrl ||
          s.questionIntroAudioUrl !== prev.questionIntroAudioUrl ||
          s.backgroundUrl !== prev.backgroundUrl
        );
      });
      if (scenes.length > 1 || mediaChanged) {
        await persistProject({ scenes: durableScenes });
      }
      const result = await stitchProjectScenes(durableScenes, {
        transition: partTransitionDefault,
        gapTransitions: syncedGaps,
      });
      setStitched(healScenesForExport(result.scenes));
      setStitchMasterAudio(result.masterAudioUrl);
      setStitchDurationMs(result.durationMs);
      setShowStitchPreview(true);
    } catch (e: unknown) {
      setStitchError(e instanceof Error ? e.message : "Stitch failed");
    } finally {
      setStitching(false);
    }
  }

  async function handleSavePart() {
    if (!stitched?.length || !stitchMasterAudio || !projectId || !project) return;
    setSavingPart(true);
    setStitchError(null);
    try {
      const now = new Date().toISOString();
      const persisted = await persistPartScenesForSave(
        stitched,
        stitchMasterAudio,
        projectId,
        (input) => apiPersistAsset(input),
      );
      const isUpdating =
        selectedPartId != null && savedParts.some((p) => p.id === selectedPartId);

      const scriptText =
        partScriptPlan != null
          ? partScriptPlanToText(partScriptPlan)
          : partScript !== undefined
            ? partScript
            : undefined;

      if (isUpdating && selectedPartId) {
        const existing = savedParts.find((p) => p.id === selectedPartId)!;
        // Never invent a new name on stitch/save — use names bar value or keep existing.
        const title = partTitle.trim() || existing.title;
        const editableScenes = persisted.scenes.map(stripSceneStitchMetadata);
        const updatedPart: ProjectPart = {
          ...existing,
          title,
          scenes: persisted.scenes,
          masterAudioUrl: persisted.masterAudioUrl,
          durationMs: stitchDurationMs,
          script: scriptText !== undefined ? scriptText : existing.script,
          scriptScenes: partScriptPlan?.scenes ?? existing.scriptScenes,
          bgm: partBgmConfig,
          transition: partTransitionDefault,
          transitions: syncGapTransitions(
            gapTransitions,
            persisted.scenes.length,
            partTransitionDefault,
          ),
          thumbnail_url: partThumb({ scenes: persisted.scenes } as ProjectPart),
          updated_at: now,
        };
        await persistProject({
          parts: savedParts.map((p) => (p.id === selectedPartId ? updatedPart : p)),
          scenes: editableScenes,
        });
        setStitched(null);
        setStitchMasterAudio(null);
        onPartSaved(title, { updated: true });
        return;
      }

      const title =
        partTitle.trim() ||
        selectedPart?.title?.trim() ||
        "Untitled part";
      const newPart: ProjectPart = {
        id: newId(),
        title,
        scenes: persisted.scenes,
        masterAudioUrl: persisted.masterAudioUrl,
        durationMs: stitchDurationMs,
        ...(isAdmin
          ? {}
          : {
              assignedUserId: myUserId ?? null,
              assignedUserEmail: myEmail ?? null,
            }),
        script: scriptText?.trim() ? scriptText : undefined,
        scriptScenes: partScriptPlan?.scenes,
        bgm: partBgmConfig,
        transition: partTransitionDefault,
        transitions: syncGapTransitions(
          gapTransitions,
          persisted.scenes.length,
          partTransitionDefault,
        ),
        thumbnail_url: partThumb({ scenes: persisted.scenes } as ProjectPart),
        created_at: now,
        updated_at: now,
      };
      const editableScenes = persisted.scenes.map(stripSceneStitchMetadata);
      await persistProject({
        parts: [...savedParts, newPart],
        scenes: editableScenes,
      });
      setStitched(null);
      setStitchMasterAudio(null);
      onSelectPart(newPart.id);
      onPartSaved(title);
    } catch (e: unknown) {
      setStitchError(e instanceof Error ? e.message : "Could not save part");
    } finally {
      setSavingPart(false);
    }
  }

  async function handleDownloadPart(part: ProjectPart, quality: ExportQuality) {
    const key = `${part.id}-${quality}`;
    setStartingExportId(key);
    try {
      const safe = part.title.replace(/[^\w\s-]/g, "").trim() || "part";
      const filename = `${safe}-${quality === "hd" ? "1080p" : "720p"}.mp4`;
      const { jobId, runner } = await startNativeExportJob({
        scenes: part.scenes,
        masterAudioUrl: part.masterAudioUrl,
        quality,
        background: DEFAULT_BACKGROUND,
        bgm: part.bgm ?? partBgmConfig,
        projectId,
        filename,
        runner: exportRunner,
      });
      void navigate({ to: "/export", search: { jobId, runner } });

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Export failed to start";
      alert(msg);
    } finally {
      setStartingExportId(null);
    }
  }

  async function deletePart(part: ProjectPart) {
    if (
      !confirm(
        `Delete saved part “${part.title}”? This removes it from the episode permanently.`,
      )
    ) {
      return;
    }
    setDeletingPartId(part.id);
    try {
      const nextParts = savedParts.filter((p) => p.id !== part.id);
      await persistProject({ parts: nextParts });
      if (selectedPartId === part.id) {
        onSelectPart(null);
        setStitched(null);
        setStitchMasterAudio(null);
        setShowStitchPreview(false);
      }
    } finally {
      setDeletingPartId(null);
    }
  }

  function sceneThumb(s: Scene): string | undefined {
    return s.compositeThumbUrl ?? s.backgroundUrl ?? s.elements?.[0]?.mediaUrl ?? undefined;
  }


  const previewScenes = stitched ?? selectedPart?.scenes ?? null;
  const previewBgm = stitched
    ? partBgmForPlayback
    : resolvePartBgm(selectedPart?.bgm) ?? partBgmForPlayback;

  return (
    <div className="flex h-full flex-col gap-3">
      {!projectId ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-xs text-muted-foreground">
          Save a scene to a project first. Scenes and stitching appear here.
        </div>
      ) : (
        <>
          <section className="rounded-lg border bg-card p-2.5">
            <p className="text-xs font-semibold">Saved part</p>
            {!selectedPart ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {visibleParts.length === 0
                  ? "No parts saved yet. Stitch scenes, then Save part."
                  : "Open a part from My Courses / episode to edit it here."}
              </p>
            ) : (
              <div className="mt-1.5 rounded-md border border-primary/40 bg-primary/5 p-2 text-xs ring-1 ring-primary/20">
                <div className="flex items-center gap-2">
                  {partThumb(selectedPart) ? (
                    <img
                      src={partThumb(selectedPart)!}
                      alt=""
                      className="h-8 w-10 shrink-0 rounded border bg-white object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-10 shrink-0 items-center justify-center rounded border bg-muted">
                      <Film size={12} />
                    </div>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{selectedPart.title}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {selectedPart.scenes.length} scene
                      {selectedPart.scenes.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <select
                    value={exportRunner}
                    onChange={(e) => {
                      const next = e.target.value === "agent" ? "agent" : "server";
                      setExportRunner(next);
                      try {
                        localStorage.setItem("explainer.exportRunner", next);
                      } catch {
                        /* ignore */
                      }
                    }}
                    className="h-7 max-w-[11rem] rounded border bg-background px-1 text-[10px]"
                    title="Where to encode"
                  >
                    <option value="server">Studio Mac</option>
                    <option value="agent">This Mac (Agent)</option>
                  </select>
                  <button
                    type="button"
                    disabled={startingExportId === `${selectedPart.id}-preview`}
                    onClick={() => handleDownloadPart(selectedPart, "preview")}
                    className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-accent disabled:opacity-50"
                  >
                    {startingExportId === `${selectedPart.id}-preview` ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Download size={10} />
                    )}
                    720p
                  </button>
                  <button
                    type="button"
                    disabled={startingExportId === `${selectedPart.id}-hd`}
                    onClick={() => handleDownloadPart(selectedPart, "hd")}
                    className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-accent disabled:opacity-50"
                  >
                    {startingExportId === `${selectedPart.id}-hd` ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Download size={10} />
                    )}
                    HD
                  </button>
                  <button
                    type="button"
                    disabled={saving || deletingPartId === selectedPart.id}
                    onClick={() => void deletePart(selectedPart)}
                    className="ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    title="Delete part"
                  >
                    {deletingPartId === selectedPart.id ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Trash2 size={10} />
                    )}
                    {deletingPartId === selectedPart.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-lg border bg-card px-2.5 py-2">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={bgmEnabled}
                onChange={(e) => {
                  const next = e.target.checked;
                  setBgmEnabled(next);
                  schedulePersistBgm(next, bgmVolume);
                }}
                className="rounded border"
              />
              <Music size={13} className="text-muted-foreground" />
              Enable background music
            </label>
            <div className="mt-1.5 space-y-0.5">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Music level</span>
                <span className="tabular-nums">{Math.round(bgmVolume * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(bgmVolume * 100)}
                disabled={!bgmEnabled}
                onChange={(e) => {
                  const next = Number(e.target.value) / 100;
                  setBgmVolume(next);
                  schedulePersistBgm(bgmEnabled, next);
                }}
                className="w-full accent-primary disabled:opacity-40"
              />
            </div>
          </section>

          <button
            type="button"
            onClick={handleStitch}
            disabled={stitching || scenes.length === 0 || saving}
            className={`inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium disabled:opacity-50 ${
              allScenesComplete
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "border border-amber-500/40 bg-amber-500/10 text-amber-900 hover:bg-amber-500/15"
            }`}
          >
            {stitching ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}
            {allScenesComplete ? "Stitch all scenes" : "Stitch all scenes (incomplete)"}
          </button>

          {stitched && stitched.length > 0 && (
            <button
              type="button"
              onClick={handleSavePart}
              disabled={savingPart || saving}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary bg-primary/5 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {savingPart ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {selectedPartId && visibleParts.some((p) => p.id === selectedPartId)
                ? "Update part"
                : "Save part"}
            </button>
          )}

          {stitchError && (
            <p className="whitespace-pre-line text-xs text-destructive">{stitchError}</p>
          )}

          {previewScenes && previewScenes.length > 0 && (
            <div className="rounded-lg border bg-card p-2">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowStitchPreview((v) => !v)}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {showStitchPreview ? "Hide" : "Show"}{" "}
                  {stitched ? "stitched" : "part"} preview
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowStitchPreview(true);
                    setFullPagePreview(true);
                  }}
                  className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium hover:bg-accent"
                  title="Watch the full stitched part on a large screen"
                >
                  <Maximize2 size={12} />
                  Full page
                </button>
              </div>
              {showStitchPreview && !fullPagePreview && (
                <div className="overflow-hidden rounded-md border">
                  <VideoPlayer
                    scenes={previewScenes}
                    background={DEFAULT_BACKGROUND}
                    bgm={previewBgm}
                    projectId={projectId}
                  />
                </div>
              )}
            </div>
          )}

          <p className="text-[10px] leading-snug text-muted-foreground">
            Between scenes: Wait (default 2s) then Slide + swoosh (default 1s).
          </p>

          {scenes.length === 0 ? (
            <p className="text-xs text-muted-foreground">No scenes saved yet.</p>
          ) : (
            <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
              {scenes.map((s, i) => {
                const gap = i < scenes.length - 1 ? gapTransitions[i] : null;
                const gapConfig = gap ? resolvePartTransition(gap) : null;
                const scriptRow = s.id ? scriptByComposeId.get(s.id) : undefined;
                const incomplete = isIncompleteComposeScene(s, scriptRow);
                return (
                  <li key={s.id ?? i} className="space-y-1">
                    <div
                      className={`rounded-md border p-2 text-xs ${
                        incomplete
                          ? "border-amber-500/40 bg-amber-500/5 opacity-90"
                          : "bg-card"
                      } ${
                        editingSceneId === s.id ? "border-primary ring-1 ring-primary/30" : ""
                      }`}
                    >
                      <div className="mb-1.5 flex items-start gap-2">
                        <span className="mt-0.5 w-4 shrink-0 text-muted-foreground">{i + 1}</span>
                        {sceneThumb(s) ? (
                          <img
                            src={sceneThumb(s)!}
                            alt=""
                            className={`h-10 w-14 shrink-0 rounded border bg-white object-contain ${
                              incomplete ? "opacity-60" : ""
                            }`}
                          />
                        ) : s.kind === "code" ? (
                          <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded border bg-slate-900 font-mono text-[10px] text-emerald-400">
                            {"{ }"}
                          </div>
                        ) : s.kind === "recording" ? (
                          <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded border bg-black text-[10px] text-orange-400">
                            REC
                          </div>
                        ) : (
                          <div className="h-10 w-14 shrink-0 rounded border bg-muted" />
                        )}
                        <div className="min-w-0 flex-1">
                          {renamingSceneId === (s.id ?? String(i)) ? (
                            <input
                              autoFocus
                              defaultValue={s.subtitle ?? s.narrationText ?? `Scene ${i + 1}`}
                              onBlur={(e) => void renameScene(i, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              }}
                              className="min-w-0 w-full rounded border px-1.5 py-0.5 text-xs"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => setRenamingSceneId(s.id ?? String(i))}
                              className="min-w-0 w-full text-left line-clamp-2 leading-snug hover:underline"
                              title="Click to rename"
                            >
                              {s.subtitle ?? s.narrationText ?? `Scene ${i + 1}`}
                            </button>
                          )}
                          {incomplete && (
                            <span className="mt-0.5 inline-block rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium text-amber-800">
                              Incomplete
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onEditScene(s, i)}
                          className="inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 hover:bg-accent"
                          title="Edit scene in composer"
                        >
                          <Pencil size={11} />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => moveScene(i, -1)}
                          disabled={i === 0 || saving}
                          className="rounded border p-0.5 hover:bg-accent disabled:opacity-40"
                          aria-label="Move up"
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveScene(i, 1)}
                          disabled={i === scenes.length - 1 || saving}
                          className="rounded border p-0.5 hover:bg-accent disabled:opacity-40"
                          aria-label="Move down"
                        >
                          <ArrowDown size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteScene(i)}
                          disabled={saving || !!deletingSceneId}
                          className="rounded border p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                          aria-label="Delete scene"
                          title="Delete scene"
                        >
                          {deletingSceneId === (s.id || `idx-${i}`) ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                        </button>
                      </div>
                    </div>

                    {gapConfig && (
                      <div className="rounded border border-dashed bg-muted/25 px-2 py-1">
                        <div className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                          <Film size={9} />
                          Transition → {i + 2}
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <label className="text-[9px] font-medium leading-none">
                            Wait
                            <input
                              type="number"
                              min={0}
                              max={15}
                              step={0.5}
                              value={gapConfig.holdMs / 1000}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                updateGapTransition(i, {
                                  holdMs: Math.round(
                                    (Number.isFinite(v)
                                      ? Math.max(0, Math.min(15, v))
                                      : 2) * 1000,
                                  ),
                                });
                              }}
                              className="mt-0.5 w-full rounded border bg-background px-1 py-0.5 text-[11px] tabular-nums"
                              title="Silence after narration, before the slide"
                            />
                          </label>
                          <label className="text-[9px] font-medium leading-none">
                            Slide
                            <input
                              type="number"
                              min={0.5}
                              max={10}
                              step={0.5}
                              value={gapConfig.durationMs / 1000}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                updateGapTransition(i, {
                                  durationMs: Math.round(
                                    (Number.isFinite(v)
                                      ? Math.max(0.5, Math.min(10, v))
                                      : 1) * 1000,
                                  ),
                                });
                              }}
                              className="mt-0.5 w-full rounded border bg-background px-1 py-0.5 text-[11px] tabular-nums"
                              title="Right-to-left swap + swoosh length"
                            />
                          </label>
                        </div>
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[9px] text-muted-foreground hover:text-foreground">
                            Effect & voice
                          </summary>
                          <div className="mt-1 grid grid-cols-1 gap-1">
                            <select
                              value={gapConfig.effect}
                              onChange={(e) =>
                                updateGapTransition(i, {
                                  effect: e.target.value as TransitionEffectId,
                                })
                              }
                              className="w-full rounded border bg-background px-1 py-0.5 text-[11px]"
                            >
                              {TRANSITION_EFFECT_OPTIONS.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            <select
                              value={gapConfig.sfxId}
                              onChange={(e) =>
                                updateGapTransition(i, {
                                  sfxId: e.target.value as TransitionSfxId,
                                })
                              }
                              className="w-full rounded border bg-background px-1 py-0.5 text-[11px]"
                            >
                              {TRANSITION_SFX_OPTIONS.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            <div className="flex items-center gap-2">
                              <span className="shrink-0 text-[9px] text-muted-foreground">
                                Voice {Math.round(gapConfig.sfxVolume * 100)}%
                              </span>
                              <input
                                type="range"
                                min={0}
                                max={100}
                                value={Math.round(gapConfig.sfxVolume * 100)}
                                onChange={(e) =>
                                  updateGapTransition(i, {
                                    sfxVolume: Number(e.target.value) / 100,
                                  })
                                }
                                className="min-w-0 flex-1 accent-primary"
                              />
                            </div>
                          </div>
                        </details>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}

      {fullPagePreview &&
        previewScenes &&
        previewScenes.length > 0 &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[200] flex flex-col bg-background text-foreground">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-card px-4 py-3 shadow-sm">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setFullPagePreview(false)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-accent"
                >
                  <ArrowLeft size={16} />
                  Back
                </button>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {stitched ? "Stitched preview" : "Part preview"} —{" "}
                    {partTitle.trim() || "Untitled part"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {previewScenes.length} scene
                    {previewScenes.length === 1 ? "" : "s"}
                    {stitchDurationMs > 0
                      ? ` · ${(stitchDurationMs / 1000).toFixed(1)}s`
                      : ""}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFullPagePreview(false)}
                className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-2 text-sm hover:bg-accent"
                aria-label="Close full page preview"
              >
                <X size={16} />
                Close
              </button>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/40 p-4 md:p-8">
              <div className="w-full max-w-6xl overflow-hidden rounded-lg border bg-card shadow-lg">
                <VideoPlayer
                  scenes={previewScenes}
                  background={DEFAULT_BACKGROUND}
                  bgm={previewBgm}
                  projectId={projectId}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
