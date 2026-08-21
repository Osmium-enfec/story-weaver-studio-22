import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Loader2, Mic, Plus, Trash2 } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ComposeImageUpload } from "@/components/compose/ComposeImageUpload";
import { ComposeVideoUpload } from "@/components/compose/ComposeVideoUpload";
import { apiGenerateTts } from "@/lib/compose-api";
import { probeAudioDurationMs } from "@/lib/audio-duration";
import { CODING_PROBLEM_TEMPLATE } from "@/lib/parse-coding-problem";
import {
  createLinkedScriptAndComposeScene,
  emptyPartScriptScene,
  goToSceneLabel,
  PART_SCRIPT_QUESTION_SUBTYPE_LABELS,
  PART_SCRIPT_QUESTION_SUBTYPES,
  PART_SCRIPT_SCENE_TYPES,
  PART_SCRIPT_TEMPLATE_SUBTYPE_LABELS,
  PART_SCRIPT_TEMPLATE_SUBTYPES,
  PART_SCRIPT_TYPE_LABELS,
  sceneNeedsNarration,
  type PartScriptPlan,
  type PartScriptQuestionSubtype,
  type PartScriptScene,
  type PartScriptSceneType,
  type PartScriptTemplateSubtype,
  type SceneCompletionProgress,
} from "@/lib/part-script";
import { newCodeTypingBeatId } from "@/lib/code-scene-sfx";

export interface PartScriptPanelProps {
  plan: PartScriptPlan;
  onChange: (plan: PartScriptPlan) => void;
  canSave: boolean;
  saving: boolean;
  /** Auto-save status shown instead of a manual Save button. */
  saveStatus?: "idle" | "pending" | "saving" | "saved" | "error";
  projectId?: string | null;
  /** Part id — used to remember which scene accordion was open across refresh. */
  selectedPartId?: string | null;
  onGoToScene?: (scene: PartScriptScene) => void;
  /** Per-scene completion (aligned with Stitch). */
  sceneCompletions?: Array<{
    index: number;
    scriptScene: PartScriptScene;
    progress: SceneCompletionProgress;
  }>;
}

export function PartScriptPanel({
  plan,
  onChange,
  canSave,
  saving,
  saveStatus = "idle",
  projectId = null,
  selectedPartId = null,
  onGoToScene,
  sceneCompletions = [],
}: PartScriptPanelProps) {
  const [ttsSceneId, setTtsSceneId] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [openSceneIds, setOpenSceneIds] = useState<string[]>([]);

  const accordionPersistKey = useMemo(
    () => `compose:script-open-scenes:${projectId ?? "none"}:${selectedPartId ?? "none"}`,
    [projectId, selectedPartId],
  );
  const sceneIdsKey = useMemo(
    () => plan.scenes.map((s) => s.id).join("|"),
    [plan.scenes],
  );

  useEffect(() => {
    const ids = plan.scenes.map((s) => s.id);
    if (ids.length === 0) {
      setOpenSceneIds([]);
      return;
    }
    setOpenSceneIds((prev) => {
      const stillOpen = prev.filter((id) => ids.includes(id));
      if (stillOpen.length > 0) return stillOpen;

      let stored: string[] = [];
      try {
        const raw = localStorage.getItem(accordionPersistKey);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            stored = parsed.filter((id): id is string => typeof id === "string");
          } else if (typeof parsed === "string") {
            stored = [parsed];
          }
        }
        // Migrate older single-id key if present.
        if (stored.length === 0) {
          const legacy = localStorage.getItem(
            `compose:script-open-scene:${projectId ?? "none"}:${selectedPartId ?? "none"}`,
          );
          if (legacy) stored = [legacy];
        }
      } catch {
        stored = [];
      }

      const fromStore = stored.filter((id) => ids.includes(id));
      const next = fromStore.length > 0 ? fromStore : [ids[0]!];
      try {
        localStorage.setItem(accordionPersistKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [accordionPersistKey, sceneIdsKey, plan.scenes, projectId, selectedPartId]);

  function setOpenScenesPersisted(next: string[]) {
    setOpenSceneIds(next);
    try {
      localStorage.setItem(accordionPersistKey, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  const completionById = new Map(
    sceneCompletions.map((row) => [row.scriptScene.id, row.progress]),
  );

  function progressFor(scene: PartScriptScene): SceneCompletionProgress {
    return (
      completionById.get(scene.id) ?? {
        percent: 0,
        missing: ["Not linked to Stitch yet"],
        complete: false,
      }
    );
  }

  function updateScene(id: string, patch: Partial<PartScriptScene>) {
    onChange({
      ...plan,
      scenes: plan.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }

  function changeType(id: string, type: PartScriptSceneType) {
    const scene = plan.scenes.find((s) => s.id === id);
    if (!scene) return;
    const idx = plan.scenes.findIndex((s) => s.id === id) + 1;
    const next = emptyPartScriptScene(type, idx);
    // Replace type-specific fields entirely (keep link id + name + optional narration).
    const updated: PartScriptScene = {
      ...next,
      id: scene.id,
      name: scene.name || next.name,
      script: sceneNeedsNarration(next) ? scene.script : "",
      audioUrl: sceneNeedsNarration(next) ? scene.audioUrl ?? null : null,
      durationMs: sceneNeedsNarration(next) ? scene.durationMs ?? 0 : 0,
    };
    onChange({
      ...plan,
      scenes: plan.scenes.map((s) => (s.id === id ? updated : s)),
    });
    // Selecting Video clip opens that compose mode immediately.
    if (type === "clip" && onGoToScene) {
      onGoToScene(updated);
    }
  }

  function addScene() {
    const { scriptScene } = createLinkedScriptAndComposeScene(
      "unset",
      plan.scenes.length + 1,
    );
    onChange({
      ...plan,
      scenes: [...plan.scenes, scriptScene],
    });
    setOpenScenesPersisted(
      openSceneIds.includes(scriptScene.id)
        ? openSceneIds
        : [...openSceneIds, scriptScene.id],
    );
  }

  function removeScene(id: string) {
    onChange({
      ...plan,
      scenes: plan.scenes.filter((s) => s.id !== id),
    });
  }

  function moveScene(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= plan.scenes.length) return;
    const next = [...plan.scenes];
    const a = next[index]!;
    const b = next[j]!;
    next[index] = b;
    next[j] = a;
    onChange({ ...plan, scenes: next });
  }

  async function generateVoice(scene: PartScriptScene) {
    const text = scene.script.trim();
    if (text.length < 3) {
      setTtsError("Enter narration text before generating voice.");
      return;
    }
    setTtsError(null);
    setTtsSceneId(scene.id);
    try {
      const tts = await apiGenerateTts(text);
      const durationMs = (await probeAudioDurationMs(tts.audioUrl)) ?? 8000;
      updateScene(scene.id, { audioUrl: tts.audioUrl, durationMs });
    } catch (e: unknown) {
      setTtsError(e instanceof Error ? e.message : "TTS failed");
    } finally {
      setTtsSceneId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!canSave && (
        <p className="text-xs text-muted-foreground">Open a part from an episode first.</p>
      )}
      {ttsError && <p className="text-sm text-destructive">{ttsError}</p>}

      <Accordion
        type="multiple"
        value={openSceneIds}
        onValueChange={(v) => setOpenScenesPersisted(v)}
        className="space-y-2"
      >
        {plan.scenes.map((scene, index) => {
          const generating = ttsSceneId === scene.id;
          const needsNarration = sceneNeedsNarration(scene);
          const qSub = scene.questionSubtype ?? "mcq";
          const tSub = scene.templateSubtype ?? "text";
          const progress = progressFor(scene);
          const typeLabel =
            scene.type === "unset"
              ? "No type"
              : PART_SCRIPT_TYPE_LABELS[scene.type];
          const goLabel =
            scene.type === "unset"
              ? "Select a type first"
              : scene.type === "intro"
                ? "Add Intro"
                : scene.type === "outro"
                  ? "Add Outro"
                  : `Go to ${goToSceneLabel(scene)}`;

          return (
            <AccordionItem
              key={scene.id}
              value={scene.id}
              className="overflow-hidden rounded-lg border bg-background px-3"
            >
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 pr-2 text-left">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Scene {index + 1}
                  </span>
                  <span className="truncate text-sm font-medium">
                    {scene.name.trim() || `Scene ${index + 1}`}
                  </span>
                  <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {typeLabel}
                  </span>
                  <span
                    className={`text-[10px] ${
                      progress.complete
                        ? "font-medium text-emerald-700"
                        : "text-muted-foreground"
                    }`}
                  >
                    {progress.complete ? "100%" : `${progress.percent}%`}
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
              <div className="space-y-3 pt-1">
              <div className="flex flex-wrap items-center justify-end gap-1">
                  <button
                    type="button"
                    disabled={index === 0 || saving}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveScene(index, -1);
                    }}
                    title="Move earlier"
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
                  >
                    <ArrowUp size={12} /> Up
                  </button>
                  <button
                    type="button"
                    disabled={index >= plan.scenes.length - 1 || saving}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveScene(index, 1);
                    }}
                    title="Move later"
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
                  >
                    <ArrowDown size={12} /> Down
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeScene(scene.id);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  >
                    {saving ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}{" "}
                    Remove
                  </button>
                  <button
                    type="button"
                    disabled={!onGoToScene || scene.type === "unset"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onGoToScene?.(scene);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-40"
                  >
                    {goLabel}
                    <ArrowRight size={12} />
                  </button>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span
                    className={
                      progress.complete
                        ? "font-medium text-emerald-700"
                        : "text-muted-foreground"
                    }
                  >
                    {progress.complete
                      ? "100% complete"
                      : `${progress.percent}% complete`}
                  </span>
                  {!progress.complete && progress.missing[0] && (
                    <span
                      className="truncate text-muted-foreground"
                      title={progress.missing.join(", ")}
                    >
                      Next: {progress.missing[0]}
                    </span>
                  )}
                </div>
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={progress.percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className={`h-full rounded-full transition-all ${
                      progress.complete ? "bg-emerald-500" : "bg-primary/70"
                    }`}
                    style={{ width: `${Math.max(4, progress.percent)}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-sm">
                  <span className="font-medium">Scene name</span>
                  <input
                    type="text"
                    value={scene.name}
                    onChange={(e) => updateScene(scene.id, { name: e.target.value })}
                    placeholder={`Scene ${index + 1}`}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span className="font-medium">Scene type</span>
                  <select
                    value={scene.type === "unset" ? "" : scene.type}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      changeType(scene.id, v as PartScriptSceneType);
                    }}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="" disabled>
                      Select scene type
                    </option>
                    {PART_SCRIPT_SCENE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {PART_SCRIPT_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {scene.type === "question" && (
                <label className="block space-y-1 text-sm">
                  <span className="font-medium">Question type</span>
                  <select
                    value={qSub}
                    onChange={(e) => {
                      const questionSubtype = e.target.value as PartScriptQuestionSubtype;
                      updateScene(scene.id, {
                        questionSubtype,
                        codingPaste:
                          questionSubtype === "coding"
                            ? scene.codingPaste || CODING_PROBLEM_TEMPLATE
                            : scene.codingPaste,
                        questionPaste:
                          questionSubtype === "mcq" ||
                          questionSubtype === "msq" ||
                          questionSubtype === "predictOutput"
                            ? scene.questionPaste ?? ""
                            : scene.questionPaste,
                      });
                    }}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {PART_SCRIPT_QUESTION_SUBTYPES.map((t) => (
                      <option key={t} value={t}>
                        {PART_SCRIPT_QUESTION_SUBTYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {scene.type === "template" && (
                <label className="block space-y-1 text-sm">
                  <span className="font-medium">Template type</span>
                  <select
                    value={tSub}
                    onChange={(e) => {
                      const templateSubtype = e.target
                        .value as PartScriptTemplateSubtype;
                      if (templateSubtype === "codeTyping") {
                        updateScene(scene.id, {
                          templateSubtype,
                          script: "",
                          audioUrl: null,
                          durationMs: 0,
                          codeTypingBeats: scene.codeTypingBeats?.length
                            ? scene.codeTypingBeats
                            : [
                                {
                                  id: newCodeTypingBeatId(),
                                  code: scene.code ?? "",
                                  output: "",
                                  outputHoldMs: 2500,
                                  runDelayMs: 700,
                                },
                              ],
                        });
                      } else {
                        updateScene(scene.id, { templateSubtype });
                      }
                    }}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {PART_SCRIPT_TEMPLATE_SUBTYPES.map((t) => (
                      <option key={t} value={t}>
                        {PART_SCRIPT_TEMPLATE_SUBTYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {(scene.type === "intro" || scene.type === "outro") && (
                <div className="space-y-2">
                  <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    Uses the {scene.type === "intro" ? "intro" : "outro"} brand bumper
                    (~12s, music included — part BGM is muted here). Click{" "}
                    <span className="font-medium text-foreground">
                      Add {scene.type === "intro" ? "Intro" : "Outro"}
                    </span>{" "}
                    to place it on this part.
                  </p>
                  {(scene.mediaUrl || scene.type === "intro" || scene.type === "outro") && (
                    <video
                      src={
                        scene.type === "outro"
                          ? COMMON_OUTRO_VIDEO_URL
                          : scene.type === "intro"
                            ? COMMON_INTRO_VIDEO_URL
                            : scene.mediaUrl!
                      }
                      className="max-h-40 w-full rounded-md border bg-black object-contain"
                      muted
                      playsInline
                      controls
                      preload="metadata"
                    />
                  )}
                </div>
              )}

              {scene.type === "image" && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Upload image</p>
                  <ComposeImageUpload
                    value={scene.imageUrl ?? null}
                    onChange={(url) => updateScene(scene.id, { imageUrl: url })}
                  />
                </div>
              )}

              {scene.type === "recording2" && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Screen recording (with sound)</p>
                  <p className="text-xs text-muted-foreground">
                    Upload a recording that already includes audio.
                  </p>
                  <ComposeVideoUpload
                    value={scene.mediaUrl ?? null}
                    projectId={projectId}
                    onUploaded={(res) =>
                      updateScene(scene.id, {
                        mediaUrl: res.url,
                        mediaDurationMs: res.durationMs,
                      })
                    }
                    onClear={() =>
                      updateScene(scene.id, { mediaUrl: null, mediaDurationMs: 0 })
                    }
                  />
                </div>
              )}

              {scene.type === "clip" && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Video clip</p>
                  <p className="text-xs text-muted-foreground">
                    Opens the Video clip tab — upload a video with embedded sound, then edit
                    zoom, blur, and highlight.
                  </p>
                  <ComposeVideoUpload
                    value={scene.mediaUrl ?? null}
                    projectId={projectId}
                    onUploaded={(res) =>
                      updateScene(scene.id, {
                        mediaUrl: res.url,
                        mediaDurationMs: res.durationMs,
                      })
                    }
                    onClear={() =>
                      updateScene(scene.id, { mediaUrl: null, mediaDurationMs: 0 })
                    }
                  />
                </div>
              )}

              {scene.type === "question" && (qSub === "mcq" || qSub === "msq") && (
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">Question</span>
                  <p className="text-xs text-muted-foreground">
                    Paste in any format — AI will structure it on the Questions tab.
                  </p>
                  <textarea
                    value={scene.questionPaste ?? ""}
                    onChange={(e) =>
                      updateScene(scene.id, { questionPaste: e.target.value })
                    }
                    rows={5}
                    placeholder={"What is …?\nA) …\nB) …\nC) …\nD) …\nCorrect: B"}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm leading-relaxed"
                  />
                </label>
              )}

              {scene.type === "question" && qSub === "coding" && (
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">Coding problem</span>
                  <p className="text-xs text-muted-foreground">
                    Same paste format as Questions → Coding problem.
                  </p>
                  <textarea
                    value={scene.codingPaste || CODING_PROBLEM_TEMPLATE}
                    onChange={(e) =>
                      updateScene(scene.id, { codingPaste: e.target.value })
                    }
                    rows={12}
                    spellCheck={false}
                    className="w-full rounded-md border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed"
                  />
                </label>
              )}

              {scene.type === "question" && qSub === "predictOutput" && (
                <div className="space-y-3">
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium">Predict output</span>
                    <p className="text-xs text-muted-foreground">
                      Question + code fence + options A–D. Opens Questions → Predict output.
                    </p>
                    <textarea
                      value={scene.questionPaste ?? ""}
                      onChange={(e) =>
                        updateScene(scene.id, { questionPaste: e.target.value })
                      }
                      rows={10}
                      spellCheck={false}
                      placeholder={
                        "What is the output of this code?\n\n```python\nx = [1, 2, 3]\nprint(x[-1])\n```\n\nA) 1\nB) 2\nC) 3\nD) Error"
                      }
                      className="w-full rounded-md border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed"
                    />
                  </label>
                </div>
              )}

              {scene.type === "coding" && (
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">Code</span>
                  <p className="text-xs text-muted-foreground">
                    Opens Compose → Coding. Refine typing steps and narration there.
                  </p>
                  <textarea
                    value={scene.code ?? ""}
                    onChange={(e) => updateScene(scene.id, { code: e.target.value })}
                    rows={8}
                    spellCheck={false}
                    placeholder={'print("Hello")'}
                    className="w-full rounded-md border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed"
                  />
                </label>
              )}

              {scene.type === "template" && (tSub === "text" || tSub === "typing") && (
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">
                    {tSub === "typing" ? "Typing text" : "Text card"}
                  </span>
                  <textarea
                    value={scene.templateText ?? ""}
                    onChange={(e) =>
                      updateScene(scene.id, { templateText: e.target.value })
                    }
                    rows={4}
                    placeholder="Your headline here"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm leading-relaxed"
                  />
                </label>
              )}

              {scene.type === "template" && tSub === "codeTyping" && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Template code typing · stepwise · no narration (BGM only). Each step:
                    type code → Run → show output.
                  </p>
                  {(scene.codeTypingBeats?.length
                    ? scene.codeTypingBeats
                    : [
                        {
                          id: newCodeTypingBeatId(),
                          code: scene.code ?? "",
                          output: "",
                          outputHoldMs: 2500,
                          runDelayMs: 700,
                        },
                      ]
                  ).map((beat, beatIndex, beats) => (
                    <div
                      key={beat.id}
                      className="space-y-2 rounded-lg border bg-muted/20 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-muted-foreground">
                          Step {beatIndex + 1}
                        </span>
                        {beats.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              const next = beats.filter((_, i) => i !== beatIndex);
                              updateScene(scene.id, {
                                codeTypingBeats: next,
                                code: next.map((b) => b.code).join("\n"),
                              });
                            }}
                            className="text-[11px] text-muted-foreground hover:text-destructive"
                          >
                            Remove step
                          </button>
                        )}
                      </div>
                      <label className="block space-y-1 text-sm">
                        <span className="font-medium">Code to type</span>
                        <textarea
                          value={beat.code}
                          onChange={(e) => {
                            const list = [...beats];
                            list[beatIndex] = { ...beat, code: e.target.value };
                            updateScene(scene.id, {
                              codeTypingBeats: list,
                              code: list.map((b) => b.code).join("\n"),
                            });
                          }}
                          rows={5}
                          spellCheck={false}
                          placeholder="# code for this step…"
                          className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-[13px] leading-relaxed"
                        />
                      </label>
                      <label className="block space-y-1 text-sm">
                        <span className="font-medium">Expected output</span>
                        <textarea
                          value={beat.output}
                          onChange={(e) => {
                            const list = [...beats];
                            list[beatIndex] = { ...beat, output: e.target.value };
                            updateScene(scene.id, { codeTypingBeats: list });
                          }}
                          rows={2}
                          spellCheck={false}
                          placeholder="Console output after Run…"
                          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-[12px]"
                        />
                      </label>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      const current =
                        scene.codeTypingBeats?.length
                          ? scene.codeTypingBeats
                          : [
                              {
                                id: newCodeTypingBeatId(),
                                code: scene.code ?? "",
                                output: "",
                                outputHoldMs: 2500,
                                runDelayMs: 700,
                              },
                            ];
                      const next = [
                        ...current,
                        {
                          id: newCodeTypingBeatId(),
                          code: "",
                          output: "",
                          outputHoldMs: 2500,
                          runDelayMs: 700,
                        },
                      ];
                      updateScene(scene.id, { codeTypingBeats: next });
                    }}
                    className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                  >
                    <Plus size={12} /> Add step
                  </button>
                </div>
              )}

              {needsNarration && (
                <>
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium">Narration / script</span>
                    <textarea
                      value={scene.script}
                      onChange={(e) => updateScene(scene.id, { script: e.target.value })}
                      rows={5}
                      placeholder="What the tutor says in this scene…"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm leading-relaxed"
                    />
                  </label>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={generating || scene.script.trim().length < 3}
                      onClick={() => void generateVoice(scene)}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                    >
                      {generating ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Mic size={16} />
                      )}
                      {generating ? "Generating voice…" : "Generate voice"}
                    </button>
                    {scene.audioUrl && (
                      <span className="text-xs text-emerald-700">
                        Voice saved
                        {scene.durationMs
                          ? ` · ${(scene.durationMs / 1000).toFixed(1)}s`
                          : ""}
                      </span>
                    )}
                  </div>
                  {scene.audioUrl && (
                    <audio controls src={scene.audioUrl} className="w-full max-w-md" />
                  )}
                </>
              )}

              </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>

      <button
        type="button"
        onClick={addScene}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-2.5 text-sm font-medium hover:bg-accent"
      >
        <Plus size={14} /> Create new scene
      </button>
    </div>
  );
}
