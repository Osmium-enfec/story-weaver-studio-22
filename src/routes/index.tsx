import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useRef } from "react";
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
  searchStockClip,
  generateNarration,
  type ScenePlan,
} from "@/lib/explainer.functions";
import { findOrGenerateImage } from "@/lib/image-library.functions";
import { saveProject } from "@/lib/projects.functions";
import { VideoPlayer, type Scene } from "@/components/VideoPlayer";
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
interface SceneProgress extends ScenePlan {
  status: SceneStatus;
  error?: string;
  mediaUrl?: string;
  audioUrl?: string;
  cached?: boolean;
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

  // ---------- Build one scene ----------
  async function buildScene(
    plan: ScenePlan,
    precomputedAudio?: { audioUrl: string; durationMs: number },
  ): Promise<Scene & { _cached?: boolean }> {
    let cachedHits = 0;
    let totalImgs = 0;
    type ImageComp = {
      kind: "image";
      backgroundUrl: string;
      elements: {
        id: string; prompt: string; x: number; y: number; w: number;
        appearAt: number; anim: any; mediaUrl: string;
      }[];
    };
    type StockOrFallback =
      | { kind: "stock"; videoUrl: string }
      | { kind: "image-fallback"; imageUrl: string };

    const visualPromise: Promise<ImageComp | StockOrFallback | null> =
      plan.kind === "code"
        ? Promise.resolve(null)
        : plan.kind === "image"
          ? (async () => {
              const comp = plan.composition!;
              totalImgs = 1 + comp.elements.length;
              const [bg, ...els] = await Promise.all([
                findOrGenerateImage({ data: { prompt: comp.backgroundPrompt, kind: "background" } }),
                ...comp.elements.map((el) =>
                  findOrGenerateImage({ data: { prompt: el.prompt, kind: "element" } }).then((r) => ({
                    ...el,
                    mediaUrl: r.dataUrl,
                    _c: r.cached,
                  })),
                ),
              ]);
              if (bg.cached) cachedHits++;
              cachedHits += els.filter((e) => e._c).length;
              return {
                kind: "image" as const,
                backgroundUrl: bg.dataUrl,
                elements: els.map(({ _c, ...rest }) => rest),
              };
            })()
          : searchStockClip({ data: { query: plan.pexelsQuery || plan.sentence } }).then(
              async (r): Promise<StockOrFallback> => {
                if (r.videoUrl) return { kind: "stock", videoUrl: r.videoUrl };
                totalImgs = 1;
                const bg = await findOrGenerateImage({ data: { prompt: plan.sentence, kind: "background" } });
                if (bg.cached) cachedHits++;
                return { kind: "image-fallback", imageUrl: bg.dataUrl };
              },
            );

    let audioPromise: Promise<{ audioUrl: string; durationMs: number }>;
    if (precomputedAudio) {
      audioPromise = Promise.resolve(precomputedAudio);
    } else {
      audioPromise = generateNarration({ data: { text: plan.narrationText || plan.sentence } }).then(
        async (r) => {
          const dur = await new Promise<number>((resolve) => {
            const a = new Audio(r.audioUrl);
            a.addEventListener("loadedmetadata", () =>
              resolve(isFinite(a.duration) ? a.duration * 1000 : 4000),
            );
            a.addEventListener("error", () => resolve(4000));
          });
          return { audioUrl: r.audioUrl, durationMs: dur };
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
    else if (visual && "backgroundUrl" in visual)
      scene = { ...base, kind: "image", backgroundUrl: visual.backgroundUrl, elements: visual.elements };
    else if (visual && visual.kind === "stock")
      scene = { ...base, kind: "stock", mediaUrl: visual.videoUrl };
    else if (visual && visual.kind === "image-fallback")
      scene = { ...base, kind: "image", backgroundUrl: visual.imageUrl, elements: [] };
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
            const s = await buildScene(p, precomputed);
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
      next[i] = { ...plan, status: "planning", error: undefined };
      return next;
    });
    try {
      // Retry after generation — reuse existing master audio window if any.
      const existing = resultsRef.current[i];
      const precomputed = existing?.masterAudioUrl
        ? { audioUrl: existing.masterAudioUrl, durationMs: (existing.endMs ?? 0) - (existing.startMs ?? 0) }
        : undefined;
      const s = await buildScene(plan, precomputed);
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
            return { ...s, audioUrl, masterAudioUrl, backgroundUrl, elements };
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
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={8}
              className="w-full rounded-lg border bg-card p-4 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="Paste your explainer script here…"
              disabled={running}
            />
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
            <div className="mb-3 rounded-md border bg-muted/40 p-3 text-xs">
              <div className="mb-1 font-medium text-foreground">
                Approx. credit usage this run
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                <span>🖼 New images: <b className="text-foreground">{stats.imagesNew}</b> (~2 cr each)</span>
                <span>♻ Cached images: <b className="text-foreground">{stats.imagesCached}</b> (free)</span>
                <span>🎙 TTS clips: <b className="text-foreground">{stats.tts}</b></span>
                <span>🧠 Plan: <b className="text-foreground">{stats.planSkipped ? "cached" : stats.plan}</b></span>
                {mode === "audio" && (
                  <span>📝 STT: <b className="text-foreground">{stats.sttSkipped ? "cached" : stats.stt}</b></span>
                )}
              </div>
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                Estimated total: <b className="text-foreground">~{stats.imagesNew * 2 + stats.tts + stats.plan + stats.stt}</b> credits.
                Re-running the same audio or script skips STT & planning; identical prompts reuse the image library — so a re-run is nearly free.
              </div>
            </div>
            <h2 className="mb-3 flex items-center justify-between text-sm font-medium text-muted-foreground">
              <span>Scenes ({progress.filter((p) => p.status === "ready").length}/{progress.length})</span>
              {totalCached > 0 && (
                <span className="text-xs text-green-600">
                  ♻ {totalCached} scene{totalCached === 1 ? "" : "s"} reused from library
                </span>
              )}
            </h2>
            <ol className="space-y-2">
              {progress.map((p, i) => (
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
                        : p.kind === "stock"
                          ? "🎬 Pexels footage"
                          : `⌨️ Code (${p.codeVariant ?? "typing"})`}
                      {p.cached ? " · ♻ reused from library" : ""}
                      {p.error ? ` · ${p.error}` : ""}
                    </div>
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
              ))}
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
            <VideoPlayer scenes={scenes} />
          </section>
        )}
      </div>
    </div>
  );
}
