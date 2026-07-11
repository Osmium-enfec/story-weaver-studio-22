import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Loader2,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Upload,
  RotateCcw,
  Save,
} from "lucide-react";
import {
  planScript,
  generateNarration,
  generateSceneComposite,
  type ScenePlan,
} from "@/lib/explainer.functions";
import { detectBoxesInImage } from "@/lib/detect-boxes.functions";
import { buildSceneRevealBoxes } from "@/lib/build-reveal";
import { findOrGenerateImage } from "@/lib/image-library.functions";
import { saveProject } from "@/lib/projects.functions";
import { VideoPlayer, type Scene } from "@/components/VideoPlayer";
import type { SceneBackground } from "@/lib/scene-background";
import bgLoopAsset from "@/assets/bg-loop.mp4.asset.json";

import {
  alignSentences,
  computeSnappedRangesMs,
  type SttResult,
} from "@/lib/audio-slice";
import { concatAudioClips } from "@/lib/audio-concat";
import { NavBar } from "@/components/NavBar";
import { supabase } from "@/integrations/supabase/client";
import {
  hashText,
  hashFile,
  getCachedPlan,
  setCachedPlan,
  getCachedStt,
  setCachedStt,
} from "@/lib/gen-cache";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Explainer Video Generator" },
      {
        name: "description",
        content:
          "Paste a script or upload audio to generate a narrated explainer video with AI images and stock footage.",
      },
    ],
  }),
  component: Index,
});

type SceneStatus = "pending" | "planning" | "ready" | "error";
type StepStatus = "running" | "ok" | "warn" | "error";
interface SceneStep { name: string; status: StepStatus; message?: string }
interface SceneProgress extends ScenePlan {
  status: SceneStatus;
  error?: string;
  mediaUrl?: string;
  audioUrl?: string;
  cached?: boolean;
  steps?: SceneStep[];
}

const SAMPLE = `Every day, billions of people search the web for answers. But search hasn't changed much in decades. Now, AI can understand what you actually mean. It reads across millions of pages in seconds. And gives you a clear, direct answer instead of a list of links. The future of search is finally here.`;

type InputMode = "script" | "audio";

// Upload local (data:/blob:) URLs to storage; leave remote URLs untouched.
// Returns a small public URL suitable for storing in the projects.scenes JSONB.
async function toPortableUrl(url: string, userId: string, projectId: string, ext: string): Promise<string> {
  if (!url) return url;
  if (/^https?:\/\//.test(url)) return url; // already remote (stock, library)
  const res = await fetch(url);
  const blob = await res.blob();
  const path = `${userId}/${projectId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("project-assets").upload(path, blob, {
    contentType: blob.type || undefined,
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from("project-assets").createSignedUrl
    ? await supabase.storage.from("project-assets").createSignedUrl(path, 60 * 60 * 24 * 365 * 5)
    : { data: null as any };
  return data?.signedUrl ?? supabase.storage.from("project-assets").getPublicUrl(path).data.publicUrl;
}

function extFromUrl(url: string, fallback: string): string {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+)/);
    if (m) {
      const mime = m[1];
      if (mime.includes("png")) return "png";
      if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
      if (mime.includes("webp")) return "webp";
      if (mime.includes("mpeg")) return "mp3";
      if (mime.includes("wav")) return "wav";
      if (mime.includes("webm")) return "webm";
      if (mime.includes("ogg")) return "ogg";
    }
  }
  return fallback;
}

function Index() {
  const [mode, setMode] = useState<InputMode>("script");
  const [script, setScript] = useState(SAMPLE);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  const navigate = useNavigate();
  const runDetect = useServerFn(detectBoxesInImage);

  const plansRef = useRef<ScenePlan[]>([]);
  
  const projectIdRef = useRef<string | null>(null);
  const storageFolderRef = useRef<string | null>(null);
  const resultsRef = useRef<(Scene | null)[]>([]);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [progress, setProgress] = useState<SceneProgress[]>([]);
  const [results, setResults] = useState<(Scene | null)[]>([]);
  const [topError, setTopError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [projectTitle, setProjectTitle] = useState<string>("");
  const [background, setBackground] = useState<SceneBackground>({ kind: "video", url: bgLoopAsset.url });


  // Approx credit-usage counters (client-side estimate, not a bill)
  const [stats, setStats] = useState({
    imagesNew: 0,
    imagesCached: 0,
    tts: 0,
    plan: 0,
    stt: 0,
    sttSkipped: false,
    planSkipped: false,
  });
  const statsRef = useRef(stats);
  function bumpStats(patch: Partial<typeof stats>) {
    statsRef.current = { ...statsRef.current, ...patch };
    setStats(statsRef.current);
  }

  function pushStep(i: number, step: SceneStep) {
    setProgress((prev) => {
      const next = [...prev];
      const cur = next[i];
      if (!cur) return prev;
      const steps = [...(cur.steps ?? [])];
      // Update existing "running" step of the same name, else append.
      const idx = steps.findIndex((s) => s.name === step.name && s.status === "running");
      if (idx >= 0) steps[idx] = step; else steps.push(step);
      next[i] = { ...cur, steps };
      return next;
    });
  }

  // ---------- Build one scene ----------
  async function buildScene(
    plan: ScenePlan,
    precomputedAudio?: { audioUrl: string; durationMs: number },
    onStep?: (s: SceneStep) => void,
  ): Promise<Scene & { _cached?: boolean }> {
    let cachedHits = 0;
    let totalImgs = 0;
    type ImageComp = {
      kind: "image";
      backgroundUrl?: string;
      title?: string;
      elements: {
        id: string; label?: string; x: number; y: number; w: number;
        appearAt: number; anim: any; mediaUrl: string;
        bbox?: { x: number; y: number; w: number; h: number };
      }[];
    };

    const emit = (s: SceneStep) => { try { onStep?.(s); } catch {} };

    const visualPromise: Promise<ImageComp | null> =
      plan.kind === "code"
        ? Promise.resolve(null)
        : (async () => {
            const comp = plan.composition;
            if (!comp) return null;
            totalImgs = 1;

            emit({ name: "composite", status: "running" });
            let result: Awaited<ReturnType<typeof generateSceneComposite>>;
            try {
              result = await generateSceneComposite({
                data: {
                  compositePrompt:
                    comp.compositePrompt ?? comp.backgroundPrompt ?? plan.sentence,
                  title: comp.title,
                },
              });
            } catch (e: any) {
              emit({ name: "composite", status: "error", message: e?.message || "failed" });
              throw e;
            }
            const serverSteps = (result as any).steps as SceneStep[] | undefined;
            if (serverSteps?.length) serverSteps.forEach((s) => emit(s));
            else emit({ name: "composite", status: "ok" });

            const { compositeUrl, elements: seg } = result;
            if (!seg.length) {
              // Single-image mode: show the composite as the scene background.
              totalImgs = 0;
              return {
                kind: "image" as const,
                title: comp.title,
                backgroundUrl: compositeUrl,
                elements: [],
              };
            }

            emit({ name: "generate-elements", status: "running" });
            let genCached = 0;
            let genNew = 0;
            const els = await Promise.all(
              seg.map(async (el, i) => {
                const bbox = el.bbox;
                const appearAt = Math.min(0.8, 0.05 + (i / Math.max(1, seg.length)) * 0.75);
                try {
                  const gen = await findOrGenerateImage({
                    data: { prompt: el.prompt, kind: "element" },
                  });
                  if (gen.cached) genCached++; else genNew++;
                  return {
                    id: el.id, label: el.label,
                    x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2, w: bbox.w,
                    appearAt, anim: "fade" as const, mediaUrl: gen.dataUrl,
                    bbox,
                  };
                } catch (e: any) {
                  console.warn(`[element] "${el.id}" gen failed:`, e?.message);
                  return {
                    id: el.id, label: el.label,
                    x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2, w: bbox.w,
                    appearAt, anim: "fade" as const, mediaUrl: compositeUrl,
                    bbox,
                  };
                }
              }),
            );
            cachedHits = genCached;
            totalImgs = genCached + genNew;
            emit({
              name: "generate-elements",
              status: "ok",
              message: `${genNew} new, ${genCached} reused`,
            });
            return { kind: "image" as const, title: comp.title, elements: els };


          })();


    let audioPromise: Promise<{ audioUrl: string; durationMs: number }>;
    if (precomputedAudio) {
      audioPromise = Promise.resolve(precomputedAudio);
    } else {
      emit({ name: "tts", status: "running" });
      audioPromise = generateNarration({ data: { text: plan.narrationText || plan.sentence } }).then(
        async (r) => {
          const dur = await new Promise<number>((resolve) => {
            const a = new Audio(r.audioUrl);
            a.addEventListener("loadedmetadata", () =>
              resolve(isFinite(a.duration) ? a.duration * 1000 : 4000),
            );
            a.addEventListener("error", () => resolve(4000));
          });
          emit({ name: "tts", status: "ok", message: `${Math.round(dur)}ms` });
          return { audioUrl: r.audioUrl, durationMs: dur };
        },
        (e) => {
          emit({ name: "tts", status: "error", message: e?.message || "tts failed" });
          throw e;
        },
      );
    }

    const [visual, audio] = await Promise.all([visualPromise, audioPromise]);
    const { audioUrl, durationMs: dur } = audio;
    const allCached = totalImgs > 0 && cachedHits === totalImgs;
    bumpStats({
      imagesNew: statsRef.current.imagesNew + (totalImgs - cachedHits),
      imagesCached: statsRef.current.imagesCached + cachedHits,
      tts: statsRef.current.tts + (precomputedAudio ? 0 : 1),
    });

    const base = {
      id: plan.id,
      subtitle: plan.subtitle,
      audioUrl,
      durationMs: dur,
      animation: plan.animation,
      code: plan.code,
      codeTo: plan.codeTo,
      codeLanguage: plan.codeLanguage,
      codeVariant: plan.codeVariant,
    };

    let scene: Scene;
    if (plan.kind === "code") scene = { ...base, kind: "code" };
    else if (visual)
      scene = {
        ...base,
        kind: "image",
        backgroundUrl: visual.backgroundUrl,
        title: visual.title,
        elements: visual.elements,
      };
    else scene = { ...base, kind: "image", backgroundUrl: undefined, elements: [] };

    return { ...scene, _cached: allCached };
  }

  async function handleGenerate() {
    setRunning(true);
    setTopError(null);
    setSaveMsg(null);
    setResults([]);
    resultsRef.current = [];
    projectIdRef.current = null;
    setProjectTitle("");
    setProgress([]);
    plansRef.current = [];
    
    statsRef.current = { imagesNew: 0, imagesCached: 0, tts: 0, plan: 0, stt: 0, sttSkipped: false, planSkipped: false };
    setStats(statsRef.current);

    try {
      // Require sign-in (image library server fn is auth-only)
      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user) {
        setTopError("Please sign in to generate — this keeps your image library synced.");
        navigate({ to: "/auth" });
        return;
      }

      let transcript = script.trim();
      let sttWords: SttResult["words"] | null = null;

      if (mode === "audio") {
        if (!audioFile) throw new Error("Please select an audio file.");
        const audioKey = await hashFile(audioFile);
        const cachedStt = getCachedStt<SttResult>(audioKey);
        if (cachedStt) {
          transcript = cachedStt.text;
          sttWords = cachedStt.words ?? [];
          bumpStats({ sttSkipped: true });
        } else {
          const form = new FormData();
          form.append("file", audioFile);
          const res = await fetch("/api/transcribe", { method: "POST", body: form });
          if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${await res.text()}`);
          const stt: SttResult = await res.json();
          transcript = stt.text;
          sttWords = stt.words ?? [];
          setCachedStt(audioKey, stt);
          bumpStats({ stt: 1 });
        }
      }

      const preserveWords = mode === "audio";
      const planKey = await hashText(`${preserveWords ? "PW:" : "SC:"}${transcript}`);
      const cachedPlan = getCachedPlan<{ scenes: ScenePlan[] }>(planKey);
      let plans: ScenePlan[];
      if (cachedPlan) {
        plans = cachedPlan.scenes;
        bumpStats({ planSkipped: true });
      } else {
        const res = await planScript({ data: { script: transcript, preserveWords } });
        plans = res.scenes;
        setCachedPlan(planKey, res);
        bumpStats({ plan: 1 });
      }
      plansRef.current = plans;

      // AUDIO MODE: compute snapped scene time windows on the ORIGINAL uploaded
      // audio. We do NOT slice — the whole file plays as a single master track,
      // and visuals switch at these timestamps.
      let audioWindows: { startMs: number; endMs: number }[] | null = null;
      let masterAudioUrl: string | null = null;
      if (mode === "audio" && sttWords && audioFile) {
        const ranges = alignSentences(plans.map((p) => p.sentence), sttWords);
        audioWindows = await computeSnappedRangesMs(audioFile, ranges);
        masterAudioUrl = URL.createObjectURL(audioFile);
      }

      const initial: SceneProgress[] = plans.map((p) => ({ ...p, status: "planning" }));
      setProgress(initial);
      const resultsArr: (Scene | null)[] = new Array(plans.length).fill(null);
      resultsRef.current = resultsArr;
      setResults([...resultsArr]);

      const CONCURRENCY = 3;
      let cursor = 0;
      async function worker() {
        while (true) {
          const i = cursor++;
          if (i >= plans.length) return;
          const p = plans[i];
          try {
            // In audio mode, skip TTS: reuse the master audio URL as a
            // placeholder and use the snapped window as the duration.
            const precomputed =
              audioWindows && masterAudioUrl
                ? {
                    audioUrl: masterAudioUrl,
                    durationMs: audioWindows[i].endMs - audioWindows[i].startMs,
                  }
                : undefined;
            const s = await buildScene(p, precomputed, (step) => pushStep(i, step));
            const { _cached, ...scene } = s as any;
            resultsArr[i] = scene;
            resultsRef.current = resultsArr;
            setResults([...resultsArr]);
            setProgress((prev) => {
              const next = [...prev];
              next[i] = { ...next[i], status: "ready", mediaUrl: scene.mediaUrl, audioUrl: scene.audioUrl, cached: _cached };
              return next;
            });
            scheduleAutoSave();
          } catch (e: any) {
            setProgress((prev) => {
              const next = [...prev];
              next[i] = { ...next[i], status: "error", error: e?.message || "failed" };
              return next;
            });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plans.length) }, worker));

      const ok = resultsArr.filter((r): r is Scene => r !== null).length;
      if (ok === 0) throw new Error("Every scene failed to generate.");

      // ---------- Build the MASTER audio ----------
      // Script mode: concatenate the per-sentence TTS clips into ONE track,
      //              then attach shared masterAudioUrl + windows to each scene.
      // Audio mode: masterAudioUrl already set to the uploaded file.
      let finalMaster = masterAudioUrl;
      let finalWindows = audioWindows;
      if (!finalMaster && mode === "script") {
        const readyOrdered = resultsArr.filter((r): r is Scene => r !== null);
        try {
          const concat = await concatAudioClips(readyOrdered.map((s) => s.audioUrl), 300);
          finalMaster = concat.url;
          // Map back to plan order (all plans succeeded → same order)
          finalWindows = concat.ranges;
        } catch (err) {
          console.warn("Concat failed, falling back to per-scene audio:", err);
        }
      }
      if (finalMaster && finalWindows) {
        const merged: (Scene | null)[] = resultsArr.map((s, i) => {
          if (!s) return null;
          const w = finalWindows![i];
          return {
            ...s,
            masterAudioUrl: finalMaster!,
            startMs: w?.startMs ?? 0,
            endMs: w?.endMs ?? (w?.startMs ?? 0) + s.durationMs,
          };
        });
        resultsRef.current = merged;
        setResults(merged);
      }

      // ---------- SAM white-cover reveal pass ----------
      // For every image scene with a backgroundUrl, segment it and build
      // white covers so the image reveals with a fade-in during playback.
      const sceneList = resultsRef.current;
      const CONC = 2;
      let rc = 0;
      async function revealWorker() {
        while (true) {
          const i = rc++;
          if (i >= sceneList.length) return;
          const s = sceneList[i];
          if (!s || s.kind !== "image" || !s.backgroundUrl) continue;
          pushStep(i, { name: "reveal-analyze", status: "running" });
          try {
            const build = await buildSceneRevealCovers(s.backgroundUrl, runSegment as any);
            if (build && build.covers.length > 0) {
              const updated: Scene = {
                ...s,
                revealCovers: build.covers,
                bgAspect: build.aspect,
              };
              sceneList[i] = updated;
              resultsRef.current = sceneList;
              setResults([...sceneList]);
              pushStep(i, {
                name: "reveal-analyze",
                status: "ok",
                message: `${build.covers.length} covers`,
              });
            } else {
              pushStep(i, { name: "reveal-analyze", status: "warn", message: "no covers" });
            }
          } catch (e: any) {
            console.warn("[reveal] scene", i, "failed:", e?.message);
            pushStep(i, { name: "reveal-analyze", status: "warn", message: e?.message || "failed" });
          }
        }
      }
      await Promise.all(Array.from({ length: CONC }, revealWorker));

      // Final autosave with all scenes settled.
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      persist(undefined, true);
    } catch (e: any) {
      setTopError(e?.message || "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }


  async function handleRetry(i: number) {
    const plan = plansRef.current[i];
    if (!plan) return;
    setProgress((prev) => {
      const next = [...prev];
      next[i] = { ...plan, status: "planning", error: undefined, steps: [] };
      return next;
    });
    try {
      // Retry after generation — reuse existing master audio window if any.
      const existing = resultsRef.current[i];
      const precomputed = existing?.masterAudioUrl
        ? { audioUrl: existing.masterAudioUrl, durationMs: (existing.endMs ?? 0) - (existing.startMs ?? 0) }
        : undefined;
      const s = await buildScene(plan, precomputed, (step) => pushStep(i, step));
      const { _cached, ...scene } = s as any;
      setResults((prev) => { const n = [...prev]; n[i] = scene; resultsRef.current = n; return n; });
      scheduleAutoSave();
      setProgress((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: "ready", mediaUrl: scene.mediaUrl, audioUrl: scene.audioUrl, cached: _cached };
        return next;
      });
    } catch (e: any) {
      setProgress((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: "error", error: e?.message || "failed" };
        return next;
      });
    }
  }

  async function persist(overrideTitle?: string, silent = false): Promise<string | null> {
    const readyScenes = resultsRef.current.filter((s): s is Scene => s !== null);
    if (readyScenes.length === 0) return null;
    if (!silent) setSaving(true);
    try {
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData.user?.id;
      if (!userId) throw new Error("Not signed in");
      if (!storageFolderRef.current) storageFolderRef.current = crypto.randomUUID();
      const pid = storageFolderRef.current;


      const title =
        (overrideTitle && overrideTitle.trim()) ||
        (projectTitle && projectTitle.trim()) ||
        (mode === "script"
          ? script.trim().split(/\s+/).slice(0, 8).join(" ") || "Untitled explainer"
          : audioFile?.name.replace(/\.[^.]+$/, "") || "Untitled explainer");

      // Upload master audio once, reuse URL on every scene.
      const rawMaster = readyScenes[0]?.masterAudioUrl;
      const portableMaster = rawMaster
        ? await toPortableUrl(rawMaster, userId, pid, extFromUrl(rawMaster, "wav"))
        : undefined;

      const portable = await Promise.all(
        readyScenes.map(async (s) => {
          // In master mode we still upload the per-scene audioUrl only when
          // it isn't identical to the master (script mode: per-scene TTS
          // clips are kept as a fallback).
          const audioUrl =
            s.audioUrl === rawMaster && portableMaster
              ? portableMaster
              : await toPortableUrl(s.audioUrl, userId, pid, extFromUrl(s.audioUrl, "mp3"));
          const masterAudioUrl = portableMaster ?? s.masterAudioUrl;
          if (s.kind === "image") {
            const backgroundUrl = s.backgroundUrl
              ? await toPortableUrl(s.backgroundUrl, userId, pid, extFromUrl(s.backgroundUrl, "png"))
              : undefined;
            const elements = await Promise.all(
              (s.elements ?? []).map(async (el) => ({
                ...el,
                mediaUrl: await toPortableUrl(el.mediaUrl, userId, pid, extFromUrl(el.mediaUrl, "png")),
              })),
            );
            // Strip revealCovers (data URLs) from persisted payload — they'll
            // be rebuilt on demand and would otherwise bloat JSONB.
            const { revealCovers: _rc, ...rest } = s;
            return { ...rest, audioUrl, masterAudioUrl, backgroundUrl, elements };
          }
          return { ...s, audioUrl, masterAudioUrl };
        }),
      );



      const firstImg = portable.find(
        (s) => s.kind === "image" && !!(s as any).backgroundUrl,
      );
      const thumbnail_url = firstImg ? (firstImg as any).backgroundUrl : undefined;

      const { id } = await saveProject({
        data: {
          id: projectIdRef.current ?? undefined,
          title,
          script: mode === "script" ? script : undefined,
          audio_mode: mode === "script" ? "tts" : "upload",
          scenes: portable,
          thumbnail_url,
        },
      });
      projectIdRef.current = id;
      setProjectTitle(title);
      setSaveMsg(silent ? `Auto-saved · ${new Date().toLocaleTimeString()}` : "Saved!");
      return id;
    } catch (e: any) {
      setSaveMsg(`Save failed: ${e?.message || e}`);
      return null;
    } finally {
      if (!silent) setSaving(false);
    }
  }

  function scheduleAutoSave() {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      persist(undefined, true);
    }, 1500);
  }

  async function handleRename() {
    const t = prompt("Rename project:", projectTitle || "Untitled explainer");
    if (!t) return;
    await persist(t, false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("audio/")) {
      setTopError("Only audio files are accepted.");
      return;
    }
    setAudioFile(f);
    setTopError(null);
  }

  const scenes: Scene[] = results.filter((r): r is Scene => r !== null);
  const totalCached = progress.filter((p) => p.cached).length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar />
      <div className="mx-auto max-w-4xl px-6 py-12">
        <header className="mb-8">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
            <Sparkles size={12} /> AI Explainer Studio
          </div>
          <h1 className="text-4xl font-bold tracking-tight">Script → Explainer video</h1>
          <p className="mt-2 text-muted-foreground">
            Paste a script or upload an audio voiceover. We generate AI images or stock footage per
            sentence, then reuse them from a shared library so future videos generate faster.
          </p>
        </header>

        <div className="mb-4 flex gap-2">
          <button
            onClick={() => setMode("script")}
            disabled={running}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              mode === "script"
                ? "bg-primary text-primary-foreground"
                : "border bg-card text-foreground hover:bg-accent"
            }`}
          >
            Text Script
          </button>
          <button
            onClick={() => setMode("audio")}
            disabled={running}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              mode === "audio"
                ? "bg-primary text-primary-foreground"
                : "border bg-card text-foreground hover:bg-accent"
            }`}
          >
            <Upload size={14} className="mr-1 inline-block" /> Upload Audio
          </button>
        </div>

        <div className="space-y-4">
          {mode === "script" && (
            <div className="space-y-2">
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                rows={10}
                className="w-full rounded-lg border bg-card p-4 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder={`Tag each scene with [scene N - TYPE], then the narration text.\n\nExample:\n[scene 1 - AI Image] Every day, billions of people search the web for answers.\n[scene 2 - AI Image] Now, AI can understand what you actually mean.\n[scene 3 - Code Typing] const answer = await ai.ask(query);`}
                disabled={running}
              />
              <p className="text-xs text-muted-foreground">
                Supported types: <code>AI Image</code>, <code>Code Typing</code>, <code>Code Morph</code>, <code>Code Scroll</code>, <code>Code Flight</code>. Without tags, we auto-chunk the script into scenes.
              </p>
            </div>
          )}


          {mode === "audio" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
                dragOver
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/30 bg-card hover:border-muted-foreground/60"
              }`}
            >
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                disabled={running}
                className="hidden"
                id="audioInput"
              />
              <label htmlFor="audioInput" className="cursor-pointer block">
                <Upload size={32} className="mx-auto mb-3 text-muted-foreground" />
                {audioFile ? (
                  <div>
                    <div className="text-sm font-medium">{audioFile.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {(audioFile.size / 1024 / 1024).toFixed(2)} MB — click or drop to replace
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="text-sm font-medium">
                      {dragOver ? "Drop your audio here" : "Drag & drop audio, or click to browse"}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      MP3, WAV, M4A, and other common audio formats
                    </div>
                  </div>
                )}
              </label>
            </div>
          )}

          <BackgroundPicker value={background} onChange={setBackground} />


          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {mode === "script"
                ? `${script.trim().split(/\s+/).filter(Boolean).length} words`
                : audioFile
                  ? audioFile.name
                  : "No audio selected"}
            </div>
            <button
              onClick={handleGenerate}
              disabled={
                running ||
                (mode === "script" && script.trim().length < 10) ||
                (mode === "audio" && !audioFile)
              }
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? (
                <><Loader2 size={16} className="animate-spin" /> Generating…</>
              ) : (
                <><Sparkles size={16} /> Generate video</>
              )}
            </button>
          </div>

          {topError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div>{topError}</div>
            </div>
          )}
        </div>

        {progress.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 flex items-center justify-between text-sm font-medium text-muted-foreground">
              <span>Scenes ({progress.filter((p) => p.status === "ready").length}/{progress.length})</span>
              {totalCached > 0 && (
                <span className="text-xs text-green-600">
                  ♻ {totalCached} scene{totalCached === 1 ? "" : "s"} reused from library
                </span>
              )}
            </h2>
            <ol className="space-y-2">
              {progress.map((p, i) => {
                const scene = results[i];
                const thumbs: string[] = [];
                if (scene?.kind === "image") {
                  if (scene.backgroundUrl) thumbs.push(scene.backgroundUrl);
                  for (const el of scene.elements ?? []) thumbs.push(el.mediaUrl);
                }
                return (
                  <li key={p.id} className="flex items-start gap-3 rounded-md border bg-card p-3 text-sm">
                    <span className="mt-0.5 w-6 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
                    <span className="mt-0.5 shrink-0">
                      {p.status === "ready" ? (
                        <CheckCircle2 size={16} className="text-green-600" />
                      ) : p.status === "error" ? (
                        <AlertCircle size={16} className="text-destructive" />
                      ) : (
                        <Loader2 size={16} className="animate-spin text-muted-foreground" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{p.sentence}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.kind === "image"
                          ? "🎨 AI image"
                          : `⌨️ Code (${p.codeVariant ?? "typing"})`}
                        {p.cached ? " · ♻ reused from library" : ""}
                        {p.error ? ` · ${p.error}` : ""}
                      </div>
                      {thumbs.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {thumbs.slice(0, 6).map((src, k) => (
                            <img
                              key={k}
                              src={src}
                              alt=""
                              className="h-16 w-16 rounded border bg-white object-contain p-1"
                            />
                          ))}
                        </div>
                      )}
                      {(p.steps?.length ?? 0) > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {p.steps!.map((s, k) => {
                            const color =
                              s.status === "ok"
                                ? "bg-green-50 text-green-700 border-green-200"
                                : s.status === "warn"
                                ? "bg-amber-50 text-amber-700 border-amber-200"
                                : s.status === "error"
                                ? "bg-red-50 text-red-700 border-red-200"
                                : "bg-muted text-muted-foreground border-border";
                            const icon =
                              s.status === "ok" ? "✓"
                              : s.status === "warn" ? "!"
                              : s.status === "error" ? "✕"
                              : "…";
                            return (
                              <span
                                key={k}
                                title={s.message || ""}
                                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${color}`}
                              >
                                <span className="font-mono">{icon}</span>
                                <span>{s.name}</span>
                                {s.message && (
                                  <span className="max-w-[220px] truncate opacity-75">· {s.message}</span>
                                )}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {p.status === "error" && !running && (
                      <button
                        onClick={() => handleRetry(i)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                      >
                        <RotateCcw size={12} /> Retry
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {scenes.length > 0 && !running && (
          <section className="mt-10">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">
                Your video {projectTitle && <span className="ml-2 text-foreground">· {projectTitle}</span>}
              </h2>
              <div className="flex items-center gap-2">
                {saveMsg && <span className="text-xs text-muted-foreground">{saveMsg}</span>}
                <button
                  onClick={handleRename}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Rename & save
                </button>
              </div>
            </div>
            <VideoPlayer scenes={scenes} background={background} />
          </section>
        )}
      </div>
    </div>
  );
}


const BG_PRESETS: { label: string; bg: SceneBackground }[] = [
  { label: "Video Loop", bg: { kind: "video", url: bgLoopAsset.url } },
  { label: "Whiteboard", bg: { kind: "whiteboard" } },
  { label: "Sky", bg: { kind: "solid", color: "#e0f2fe" } },
  { label: "Mint", bg: { kind: "solid", color: "#dcfce7" } },
  { label: "Blush", bg: { kind: "solid", color: "#ffe4e6" } },
  { label: "Slate", bg: { kind: "solid", color: "#1e293b" } },
  { label: "Purple → Pink", bg: { kind: "gradient", from: "#a78bfa", to: "#f472b6" } },
  { label: "Teal → Blue", bg: { kind: "gradient", from: "#5eead4", to: "#3b82f6" } },
  { label: "Sunset", bg: { kind: "gradient", from: "#fb923c", to: "#ec4899" } },
];

function BackgroundPicker({
  value,
  onChange,
}: {
  value: SceneBackground;
  onChange: (bg: SceneBackground) => void;
}) {
  const isActive = (bg: SceneBackground) => JSON.stringify(bg) === JSON.stringify(value);
  const preview = (bg: SceneBackground) => {
    if (bg.kind === "solid") return bg.color;
    if (bg.kind === "gradient") return `linear-gradient(${bg.angle ?? 135}deg, ${bg.from}, ${bg.to})`;
    if (bg.kind === "video") return "linear-gradient(135deg, #0f172a, #6366f1)";
    return "repeating-linear-gradient(45deg, #f8fafc 0 8px, #eef2f7 8px 16px)";
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Background:</span>
      {BG_PRESETS.map((p) => (
        <button
          key={p.label}
          onClick={() => onChange(p.bg)}
          className={`flex items-center gap-2 rounded-full border px-2 py-1 text-xs transition ${
            isActive(p.bg) ? "border-primary ring-2 ring-primary/30" : "border-input hover:bg-accent"
          }`}
        >
          <span
            className="inline-block h-4 w-4 rounded-full border"
            style={{ background: preview(p.bg) }}
          />
          {p.label}
        </button>
      ))}
    </div>
  );
}

