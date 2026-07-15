import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Film,
  Loader2,
  Music,
  Pencil,
  Save,
} from "lucide-react";
import { VideoPlayer, type Scene } from "@/components/VideoPlayer";
import { saveProject } from "@/lib/projects.functions";
import { exportToMp4, downloadBlob, type ExportQuality } from "@/lib/ffmpeg-stitcher";
import {
  defaultPartTitle,
  getProjectParts,
  partThumb,
  type ProjectPart,
} from "@/lib/project-parts";
import { stitchProjectScenes, STITCH_TRANSITION_MS } from "@/lib/stitch-project-scenes";
import { DEFAULT_BACKGROUND } from "@/lib/scene-background";
import { DEFAULT_PART_BGM, type PartBgmConfig } from "@/lib/part-bgm";
import { persistPartScenesForSave } from "@/lib/persist-client-asset";
import { persistProjectAsset } from "@/lib/project-assets.functions";
import { stripSceneStitchMetadata } from "@/lib/compose-scene";

function newId(): string {
  return crypto.randomUUID();
}

interface ProjectRecord {
  id: string;
  title: string;
  script?: string | null;
  audio_mode: string;
  thumbnail_url?: string | null;
  scenes?: unknown;
  parts?: unknown;
  workshop_draft?: unknown;
}

interface ComposeProjectPanelProps {
  projectId?: string;
  project?: ProjectRecord | null;
  partTitle: string;
  onPartTitleChange: (v: string) => void;
  selectedPartId: string | null;
  onSelectPart: (id: string | null) => void;
  onStitchStateChange: (active: boolean) => void;
  onPartSaved: (nextPartTitle: string, opts?: { updated?: boolean }) => void;
  onLoadPartForEdit: (part: ProjectPart) => void | Promise<void>;
  onEditScene: (scene: Scene, index: number) => void;
  editingSceneId: string | null;
}

export function ComposeProjectPanel({
  projectId,
  project,
  partTitle,
  onPartTitleChange,
  selectedPartId,
  onSelectPart,
  onStitchStateChange,
  onPartSaved,
  onLoadPartForEdit,
  onEditScene,
  editingSceneId,
}: ComposeProjectPanelProps) {
  const qc = useQueryClient();
  const runSave = useServerFn(saveProject);
  const runPersistAsset = useServerFn(persistProjectAsset);

  const [saving, setSaving] = useState(false);
  const [savingPart, setSavingPart] = useState(false);
  const [stitching, setStitching] = useState(false);
  const [stitchError, setStitchError] = useState<string | null>(null);
  const [stitched, setStitched] = useState<Scene[] | null>(null);
  const [stitchMasterAudio, setStitchMasterAudio] = useState<string | null>(null);
  const [stitchDurationMs, setStitchDurationMs] = useState(0);
  const [showStitchPreview, setShowStitchPreview] = useState(false);
  const [downloadingPartId, setDownloadingPartId] = useState<string | null>(null);
  const [renamingSceneId, setRenamingSceneId] = useState<string | null>(null);
  const [bgmEnabled, setBgmEnabled] = useState(DEFAULT_PART_BGM.enabled !== false);
  const [bgmVolume, setBgmVolume] = useState(DEFAULT_PART_BGM.volume);

  const scenes = ((project?.scenes as Scene[] | undefined) ?? []).slice();
  const savedParts = getProjectParts(project ?? undefined);
  const selectedPart = savedParts.find((p) => p.id === selectedPartId) ?? null;

  const partBgmConfig = useMemo((): PartBgmConfig | null => {
    if (!bgmEnabled) return null;
    return {
      url: DEFAULT_PART_BGM.url,
      volume: bgmVolume,
      enabled: true,
    };
  }, [bgmEnabled, bgmVolume]);

  useEffect(() => {
    if (selectedPart?.bgm) {
      setBgmEnabled(selectedPart.bgm.enabled !== false);
      setBgmVolume(selectedPart.bgm.volume);
    }
  }, [selectedPart?.id, selectedPart?.bgm?.volume, selectedPart?.bgm?.enabled]);

  useEffect(() => {
    onStitchStateChange(!!stitched && stitched.length > 0);
  }, [stitched, onStitchStateChange]);

  useEffect(() => {
    if (stitched && stitched.length > 0 && !partTitle.trim()) {
      onPartTitleChange(defaultPartTitle(savedParts));
    }
  }, [stitched, savedParts.length, partTitle, onPartTitleChange]);

  async function persistProject(update: {
    scenes?: Scene[];
    parts?: ProjectPart[];
    title?: string;
  }) {
    if (!projectId || !project) return;
    setSaving(true);
    setStitchError(null);
    try {
      await runSave({
        data: {
          id: projectId,
          title: update.title ?? project.title,
          script: project.script ?? undefined,
          audio_mode: project.audio_mode as "tts" | "upload",
          scenes: update.scenes ?? scenes,
          parts: update.parts ?? savedParts,
          thumbnail_url: project.thumbnail_url ?? undefined,
        },
      });
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
    } finally {
      setSaving(false);
    }
  }

  async function persistScenes(next: Scene[]) {
    await persistProject({ scenes: next });
    setStitched(null);
    setStitchMasterAudio(null);
  }

  async function openPartForEdit(part: ProjectPart) {
    setStitched(null);
    setStitchMasterAudio(null);
    setShowStitchPreview(false);
    await onLoadPartForEdit(part);
  }

  function moveScene(index: number, dir: -1 | 1) {
    const next = [...scenes];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
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

  async function handleStitch() {
    if (scenes.length === 0) return;
    setStitching(true);
    setStitchError(null);
    try {
      const result = await stitchProjectScenes(scenes, {
        transitionMs: STITCH_TRANSITION_MS,
      });
      setStitched(result.scenes);
      setStitchMasterAudio(result.masterAudioUrl);
      setStitchDurationMs(result.durationMs);
      onPartTitleChange(defaultPartTitle(savedParts));
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
      const title = partTitle.trim() || defaultPartTitle(savedParts);
      const persisted = await persistPartScenesForSave(
        stitched,
        stitchMasterAudio,
        projectId,
        (input) => runPersistAsset({ data: input }),
      );
      const isUpdating =
        selectedPartId != null && savedParts.some((p) => p.id === selectedPartId);

      if (isUpdating && selectedPartId) {
        const editableScenes = persisted.scenes.map(stripSceneStitchMetadata);
        const updatedPart: ProjectPart = {
          ...savedParts.find((p) => p.id === selectedPartId)!,
          title,
          scenes: persisted.scenes,
          masterAudioUrl: persisted.masterAudioUrl,
          durationMs: stitchDurationMs,
          bgm: partBgmConfig ?? undefined,
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

      const newPart: ProjectPart = {
        id: newId(),
        title,
        scenes: persisted.scenes,
        masterAudioUrl: persisted.masterAudioUrl,
        durationMs: stitchDurationMs,
        bgm: partBgmConfig ?? undefined,
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
      onPartSaved(defaultPartTitle([...savedParts, newPart]));
    } catch (e: unknown) {
      setStitchError(e instanceof Error ? e.message : "Could not save part");
    } finally {
      setSavingPart(false);
    }
  }

  async function handleDownloadPart(part: ProjectPart, quality: ExportQuality) {
    setDownloadingPartId(`${part.id}-${quality}`);
    try {
      const blob = await exportToMp4(
        part.scenes,
        part.masterAudioUrl,
        quality,
        () => {},
        DEFAULT_BACKGROUND,
        part.bgm ?? partBgmConfig ?? undefined,
      );
      const safe = part.title.replace(/[^\w\s-]/g, "").trim() || "part";
      downloadBlob(blob, `${safe}-${quality === "hd" ? "1080p" : "720p"}.mp4`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Download failed";
      alert(msg.includes("fetch") || msg.includes("Failed to fetch")
        ? "Download failed: stitched audio is missing or expired. Re-stitch the part, click Save part, then download again."
        : msg);
    } finally {
      setDownloadingPartId(null);
    }
  }

  function sceneThumb(s: Scene): string | undefined {
    return s.compositeThumbUrl ?? s.backgroundUrl ?? s.elements?.[0]?.mediaUrl ?? undefined;
  }

  const previewScenes = stitched ?? selectedPart?.scenes ?? null;
  const previewBgm = stitched ? partBgmConfig : selectedPart?.bgm ?? partBgmConfig;

  return (
    <div className="flex h-full flex-col gap-4">
      <section className="rounded-lg border bg-card p-3">
        <p className="text-sm font-semibold">Saved parts</p>
        <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
          Click a part to load its scenes for editing. All parts are kept on this Mac.
        </p>

        {!projectId ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Open a project to see saved parts.
          </p>
        ) : savedParts.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            No parts saved yet. Stitch your scenes and click Save part.
          </p>
        ) : (
          <ul className="mt-3 max-h-52 space-y-1.5 overflow-y-auto pr-0.5">
            {savedParts.map((part) => (
              <li
                key={part.id}
                className={`rounded-md border p-2 text-xs ${
                  selectedPartId === part.id ? "border-primary bg-primary/5 ring-1 ring-primary/30" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => void openPartForEdit(part)}
                  className="flex w-full items-center gap-2 text-left"
                >
                  {partThumb(part) ? (
                    <img
                      src={partThumb(part)!}
                      alt=""
                      className="h-8 w-10 shrink-0 rounded border bg-white object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-10 shrink-0 items-center justify-center rounded border bg-muted">
                      <Film size={12} />
                    </div>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{part.title}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {part.scenes.length} scene{part.scenes.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <button
                    type="button"
                    disabled={!!downloadingPartId}
                    onClick={() => handleDownloadPart(part, "preview")}
                    className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-accent disabled:opacity-50"
                  >
                    {downloadingPartId === `${part.id}-preview` ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Download size={10} />
                    )}
                    720p
                  </button>
                  <button
                    type="button"
                    disabled={!!downloadingPartId}
                    onClick={() => handleDownloadPart(part, "hd")}
                    className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-accent disabled:opacity-50"
                  >
                    {downloadingPartId === `${part.id}-hd` ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Download size={10} />
                    )}
                    HD
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!projectId ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-xs text-muted-foreground">
          Save a scene to a project first. Scenes and stitching appear here.
        </div>
      ) : (
        <>
          <div>
            <p className="text-sm font-semibold">{project?.title ?? "Project"}</p>
            <p className="text-xs text-muted-foreground">
              Part: <span className="font-medium text-foreground">{partTitle || "Unnamed part"}</span>
              {selectedPartId && (
                <span className="text-primary"> · editing saved part</span>
              )}
              {" · "}
              {scenes.length} scene{scenes.length === 1 ? "" : "s"}
            </p>
          </div>

          <section className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              <Music size={14} className="text-muted-foreground" />
              <p className="text-sm font-semibold">Background music</p>
            </div>
            <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
              One continuous track for the whole part — no restart between scenes. Stops at part end.
            </p>
            <label className="mt-3 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={bgmEnabled}
                onChange={(e) => setBgmEnabled(e.target.checked)}
                className="rounded border"
              />
              Enable background music
            </label>
            <div className="mt-2 space-y-1">
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
                onChange={(e) => setBgmVolume(Number(e.target.value) / 100)}
                className="w-full accent-primary disabled:opacity-40"
              />
            </div>
          </section>

          <button
            type="button"
            onClick={handleStitch}
            disabled={stitching || scenes.length === 0 || saving}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {stitching ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}
            Stitch all scenes
          </button>

          {stitched && stitched.length > 0 && (
            <button
              type="button"
              onClick={handleSavePart}
              disabled={savingPart || saving}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary bg-primary/5 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {savingPart ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {selectedPartId && savedParts.some((p) => p.id === selectedPartId)
                ? "Update part"
                : "Save part"}
            </button>
          )}

          <p className="text-[10px] leading-snug text-muted-foreground">
            Per-scene hold (2s default; longer after questions) + {STITCH_TRANSITION_MS}ms slide +
            whoosh between scenes
          </p>

          {stitchError && <p className="text-xs text-destructive">{stitchError}</p>}

          {scenes.length === 0 ? (
            <p className="text-xs text-muted-foreground">No scenes saved yet.</p>
          ) : (
            <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {scenes.map((s, i) => (
                <li
                  key={s.id ?? i}
                  className={`rounded-md border bg-card p-2 text-xs ${
                    editingSceneId === s.id ? "border-primary ring-1 ring-primary/30" : ""
                  }`}
                >
                  <div className="mb-1.5 flex items-start gap-2">
                    <span className="mt-0.5 w-4 shrink-0 text-muted-foreground">{i + 1}</span>
                    {sceneThumb(s) ? (
                      <img
                        src={sceneThumb(s)!}
                        alt=""
                        className="h-10 w-14 shrink-0 rounded border bg-white object-contain"
                      />
                    ) : s.kind === "code" ? (
                      <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded border bg-slate-900 font-mono text-[10px] text-emerald-400">
                        {"{ }"}
                      </div>
                    ) : (
                      <div className="h-10 w-14 shrink-0 rounded border bg-muted" />
                    )}
                    {renamingSceneId === (s.id ?? String(i)) ? (
                      <input
                        autoFocus
                        defaultValue={s.subtitle ?? s.narrationText ?? `Scene ${i + 1}`}
                        onBlur={(e) => void renameScene(i, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                        className="min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRenamingSceneId(s.id ?? String(i))}
                        className="min-w-0 flex-1 text-left line-clamp-2 leading-snug hover:underline"
                        title="Click to rename"
                      >
                        {s.subtitle ?? s.narrationText ?? `Scene ${i + 1}`}
                      </button>
                    )}
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
                  </div>
                </li>
              ))}
            </ol>
          )}

          {previewScenes && previewScenes.length > 0 && (
            <div className="border-t pt-3">
              <button
                type="button"
                onClick={() => setShowStitchPreview((v) => !v)}
                className="mb-2 text-xs font-medium text-primary hover:underline"
              >
                {showStitchPreview ? "Hide" : "Show"}{" "}
                {stitched ? "stitched" : "part"} preview
              </button>
              {showStitchPreview && (
                <div className="overflow-hidden rounded-md border">
                  <VideoPlayer
                    scenes={previewScenes}
                    background={DEFAULT_BACKGROUND}
                    bgm={previewBgm}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}