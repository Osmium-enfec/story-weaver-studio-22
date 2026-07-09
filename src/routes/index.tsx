import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2, Sparkles, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  planScript,
  generateSceneImage,
  searchStockClip,
  generateNarration,
  type ScenePlan,
} from "@/lib/explainer.functions";
import { VideoPlayer, type Scene } from "@/components/VideoPlayer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Explainer Video Generator" },
      {
        name: "description",
        content:
          "Paste a script and generate a narrated explainer video with AI images and stock footage.",
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
}

const SAMPLE = `Every day, billions of people search the web for answers. But search hasn't changed much in decades. Now, AI can understand what you actually mean. It reads across millions of pages in seconds. And gives you a clear, direct answer instead of a list of links. The future of search is finally here.`;

function Index() {
  const [script, setScript] = useState(SAMPLE);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SceneProgress[]>([]);
  const [scenes, setScenes] = useState<Scene[] | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  async function buildScene(plan: ScenePlan): Promise<Scene> {
    const mediaPromise: Promise<{ url?: string; fellBack?: boolean } | null> =
      plan.kind === "code"
        ? Promise.resolve(null)
        : plan.kind === "image"
          ? generateSceneImage({ data: { prompt: plan.imagePrompt || plan.sentence } }).then(
              (r) => ({ url: r.dataUrl }),
            )
          : searchStockClip({ data: { query: plan.pexelsQuery || plan.sentence } }).then(
              async (r) => {
                if (r.videoUrl) return { url: r.videoUrl };
                const img = await generateSceneImage({
                  data: { prompt: plan.sentence },
                });
                return { url: img.dataUrl, fellBack: true };
              },
            );

    const [media, audio] = await Promise.all([
      mediaPromise,
      generateNarration({ data: { text: plan.narrationText || plan.sentence } }),
    ]);

    const dur = await new Promise<number>((resolve) => {
      const a = new Audio(audio.audioUrl);
      a.addEventListener("loadedmetadata", () =>
        resolve(isFinite(a.duration) ? a.duration * 1000 : 4000),
      );
      a.addEventListener("error", () => resolve(4000));
    });

    return {
      id: plan.id,
      subtitle: plan.subtitle,
      kind:
        plan.kind === "stock" && media?.fellBack ? "image" : plan.kind,
      mediaUrl: media?.url,
      audioUrl: audio.audioUrl,
      durationMs: dur,
      animation: plan.animation,
      code: plan.code,
      codeTo: plan.codeTo,
      codeLanguage: plan.codeLanguage,
      codeVariant: plan.codeVariant,
    };
  }

  async function handleGenerate() {
    setRunning(true);
    setTopError(null);
    setScenes(null);
    setProgress([]);
    try {
      const { scenes: plans } = await planScript({ data: { script } });
      const initial: SceneProgress[] = plans.map((p) => ({ ...p, status: "planning" }));
      setProgress(initial);

      const results = await Promise.all(
        plans.map(async (p, i) => {
          try {
            const s = await buildScene(p);
            setProgress((prev) => {
              const next = [...prev];
              next[i] = { ...next[i], status: "ready", mediaUrl: s.mediaUrl, audioUrl: s.audioUrl };
              return next;
            });
            return s;
          } catch (e: any) {
            setProgress((prev) => {
              const next = [...prev];
              next[i] = { ...next[i], status: "error", error: e?.message || "failed" };
              return next;
            });
            return null;
          }
        }),
      );

      const ok = results.filter((r): r is Scene => r !== null);
      if (ok.length === 0) throw new Error("Every scene failed to generate.");
      setScenes(ok);
    } catch (e: any) {
      setTopError(e?.message || "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-12">
        <header className="mb-8">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
            <Sparkles size={12} /> AI Explainer Studio
          </div>
          <h1 className="text-4xl font-bold tracking-tight">Script → Explainer video</h1>
          <p className="mt-2 text-muted-foreground">
            Paste a script. We split it into sentences, generate an AI image or fetch stock
            footage for each, narrate it, and play it back synced.
          </p>
        </header>

        <div className="space-y-4">
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={8}
            className="w-full rounded-lg border bg-card p-4 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="Paste your explainer script here…"
            disabled={running}
          />

          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {script.trim().split(/\s+/).filter(Boolean).length} words · up to 40 sentences
            </div>
            <button
              onClick={handleGenerate}
              disabled={running || script.trim().length < 10}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Generating…
                </>
              ) : (
                <>
                  <Sparkles size={16} /> Generate video
                </>
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
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">
              Scenes ({progress.filter((p) => p.status === "ready").length}/{progress.length})
            </h2>
            <ol className="space-y-2">
              {progress.map((p, i) => (
                <li
                  key={p.id}
                  className="flex items-start gap-3 rounded-md border bg-card p-3 text-sm"
                >
                  <span className="mt-0.5 w-6 shrink-0 text-xs text-muted-foreground">
                    {i + 1}
                  </span>
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
                      {p.kind === "image" ? "🎨 AI image" : "🎬 Pexels footage"}
                      {p.error ? ` · ${p.error}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {scenes && scenes.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 text-sm font-medium text-muted-foreground">Your video</h2>
            <VideoPlayer scenes={scenes} />
          </section>
        )}
      </div>
    </div>
  );
}
