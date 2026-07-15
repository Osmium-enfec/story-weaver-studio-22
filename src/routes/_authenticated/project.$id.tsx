import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import {
  getProject,
  saveProject,
} from "@/lib/projects.functions";
import { VideoPlayer, type Scene } from "@/components/VideoPlayer";
import { NavBar } from "@/components/NavBar";
import {
  Loader2,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Film,
  Plus,
} from "lucide-react";
import { stitchProjectScenes, STITCH_TRANSITION_MS } from "@/lib/stitch-project-scenes";
import { DEFAULT_BACKGROUND } from "@/lib/scene-background";

export const Route = createFileRoute("/_authenticated/project/$id")({
  head: () => ({ meta: [{ title: "Project — Explainer Studio" }] }),
  component: ProjectDetail,
});

function ProjectDetail() {
  const { id } = Route.useParams();
  const get = useServerFn(getProject);
  const runSave = useServerFn(saveProject);
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["project", id],
    queryFn: async () => {
      const timeoutMs = 25_000;
      return Promise.race([
        get({ data: { id } }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "This project is taking too long to load (large scenes or cloud DB issue). Open it from Compose instead.",
                ),
              ),
            timeoutMs,
          ),
        ),
      ]);
    },
    retry: 1,
    staleTime: 10_000,
  });

  const [scenes, setScenes] = useState<Scene[]>([]);
  const [stitched, setStitched] = useState<Scene[] | null>(null);
  const [stitching, setStitching] = useState(false);
  const [stitchError, setStitchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadedScenes = (data?.scenes as Scene[] | undefined) ?? [];
  const displayScenes = scenes.length ? scenes : loadedScenes;

  useEffect(() => {
    if (data?.scenes) {
      setScenes(data.scenes as Scene[]);
      setStitched(null);
    }
  }, [data]);

  async function persistScenes(next: Scene[]) {
    if (!data) return;
    setSaving(true);
    try {
      await runSave({
        data: {
          id: data.id,
          title: data.title,
          script: data.script ?? undefined,
          audio_mode: data.audio_mode as "tts" | "upload",
          scenes: next,
          thumbnail_url: data.thumbnail_url ?? undefined,
        },
      });
      setScenes(next);
      setStitched(null);
      await qc.invalidateQueries({ queryKey: ["project", id] });
    } finally {
      setSaving(false);
    }
  }

  function moveScene(index: number, dir: -1 | 1) {
    const next = [...displayScenes];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j]!, next[index]!];
    void persistScenes(next);
  }

  async function handleStitch() {
    if (displayScenes.length === 0) return;
    setStitching(true);
    setStitchError(null);
    try {
      const result = await stitchProjectScenes(displayScenes, {
        transitionMs: STITCH_TRANSITION_MS,
      });
      setStitched(result.scenes);
    } catch (e: unknown) {
      setStitchError(e instanceof Error ? e.message : "Stitch failed");
    } finally {
      setStitching(false);
    }
  }

  const playerScenes = stitched ?? displayScenes;

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto max-w-4xl px-6 py-8">
        <Link
          to="/projects"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> Back to projects
        </Link>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6">
            <p className="text-destructive">{(error as Error).message}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                to="/compose"
                search={{ project: id }}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Open in Compose
              </Link>
              <Link
                to="/projects"
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                Back to projects
              </Link>
            </div>
          </div>
        ) : data ? (
          <>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold">{data.title}</h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  {displayScenes.length} scene{displayScenes.length === 1 ? "" : "s"} · Saved{" "}
                  {new Date(data.updated_at).toLocaleString()}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/compose"
                  search={{ project: id }}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                >
                  <Plus size={14} /> Add scene
                </Link>
                <button
                  type="button"
                  onClick={handleStitch}
                  disabled={stitching || displayScenes.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {stitching ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Film size={14} />
                  )}
                  Stitch &amp; preview
                </button>
              </div>
            </div>

            {stitchError && (
              <p className="mb-4 text-sm text-destructive">{stitchError}</p>
            )}

            {stitched && (
              <p className="mb-4 text-xs text-muted-foreground">
                Stitched with per-scene hold + {STITCH_TRANSITION_MS}ms transition + whoosh SFX
              </p>
            )}

            {displayScenes.length > 0 && (
              <ol className="mb-8 space-y-2">
                {displayScenes.map((s, i) => (
                  <li
                    key={s.id ?? i}
                    className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm"
                  >
                    <span className="w-6 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
                    {s.kind === "image" &&
                      (s.compositeThumbUrl ?? s.backgroundUrl ?? s.elements?.[0]?.mediaUrl) && (
                      <img
                        src={s.compositeThumbUrl ?? s.backgroundUrl ?? s.elements?.[0]?.mediaUrl}
                        alt=""
                        className="h-12 w-16 rounded border bg-white object-contain"
                      />
                    )}
                    <div className="min-w-0 flex-1 truncate">
                      {s.subtitle ?? s.narrationText ?? `Scene ${i + 1}`}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => moveScene(i, -1)}
                        disabled={i === 0 || saving}
                        className="rounded border p-1 hover:bg-accent disabled:opacity-40"
                        aria-label="Move up"
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveScene(i, 1)}
                        disabled={i === displayScenes.length - 1 || saving}
                        className="rounded border p-1 hover:bg-accent disabled:opacity-40"
                        aria-label="Move down"
                      >
                        <ArrowDown size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            {playerScenes.length > 0 && (
              <VideoPlayer scenes={playerScenes} background={DEFAULT_BACKGROUND} />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
