import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, RotateCcw, Download, Loader2 } from "lucide-react";
import { CodeScene, type CodeVariant } from "./CodeScene";
import type { CompositionElement } from "@/lib/explainer.functions";
import { renderVideo, downloadBlob, type RenderQuality } from "@/lib/render-video";

export interface ResolvedElement extends CompositionElement {
  mediaUrl: string;
}

export interface Scene {
  id: string;
  subtitle: string;
  kind: "image" | "stock" | "code";
  /** stock: video URL */
  mediaUrl?: string;
  /** image: composited background + elements */
  backgroundUrl?: string;
  elements?: ResolvedElement[];
  /** Per-scene TTS clip (used when there is no master track / for fallback). */
  audioUrl: string;
  durationMs: number;
  animation: "kenburns-in" | "kenburns-out" | "fade" | "slide-left";
  code?: string;
  codeTo?: string;
  codeLanguage?: string;
  codeVariant?: CodeVariant;
  /**
   * When set, the whole video shares ONE continuous audio track and
   * this scene occupies [startMs, endMs] of it. All scenes in a set
   * must carry the same masterAudioUrl.
   */
  masterAudioUrl?: string;
  startMs?: number;
  endMs?: number;
}

function ImageScene({
  scene,
  progress,
}: {
  scene: Scene;
  progress: number;
}) {
  const t = progress;
  const bgStyle: React.CSSProperties =
    scene.animation === "kenburns-in"
      ? { transform: `scale(${1 + 0.08 * t})` }
      : scene.animation === "kenburns-out"
        ? { transform: `scale(${1.08 - 0.08 * t})` }
        : scene.animation === "slide-left"
          ? { transform: `translateX(${(0.5 - t) * 20}px) scale(1.04)` }
          : { transform: "scale(1.02)" };

  return (
    <div className="relative h-full w-full overflow-hidden bg-white">
      {scene.backgroundUrl && (
        <img
          src={scene.backgroundUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-100 ease-linear"
          style={bgStyle}
        />
      )}
      {scene.elements?.map((el) => {
        const single = (scene.elements?.length ?? 0) === 1;
        const shown = t >= el.appearAt;
        const revealWindow = Math.max(0.02, 450 / Math.max(1, scene.durationMs));
        const p = shown ? Math.min(1, (t - el.appearAt) / revealWindow) : 0;
        const eased = 1 - Math.pow(1 - p, 3);

        let transform = "";
        const opacity = eased;
        switch (el.anim) {
          case "pop":
            transform = `scale(${0.6 + 0.4 * eased})`;
            break;
          case "fade":
            transform = "scale(1)";
            break;
          case "slide-up":
            transform = `translateY(${(1 - eased) * 40}px)`;
            break;
          case "slide-left":
            transform = `translateX(${(1 - eased) * -60}px)`;
            break;
          case "slide-right":
            transform = `translateX(${(1 - eased) * 60}px)`;
            break;
        }

        const width = single ? Math.max(0.6, el.w * 2.2) : el.w;
        const leftPct = single ? 50 : el.x * 100;
        const topPct = single ? 50 : el.y * 100;

        return (
          <img
            key={el.id}
            src={el.mediaUrl}
            alt=""
            className="absolute select-none"
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${width * 100}%`,
              transform: `translate(-50%, -50%) ${transform}`,
              transformOrigin: "center center",
              opacity,
              mixBlendMode: "multiply",
              transition: "none",
              pointerEvents: "none",
            }}
            draggable={false}
          />
        );
      })}
    </div>
  );
}

function SceneStage({
  scene,
  progress,
  videoRef,
}: {
  scene: Scene;
  progress: number;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}) {
  if (scene.kind === "code") {
    return (
      <CodeScene
        code={scene.code ?? ""}
        codeTo={scene.codeTo}
        language={scene.codeLanguage}
        variant={scene.codeVariant ?? "typing"}
        progress={progress}
      />
    );
  }
  if (scene.kind === "image") {
    return <ImageScene scene={scene} progress={progress} />;
  }
  return (
    <video
      ref={videoRef}
      src={scene.mediaUrl}
      muted
      playsInline
      className="h-full w-full object-cover"
    />
  );
}

// Visual crossfade between scenes. Audio is continuous underneath, so the
// crossfade just softens the visual cut — no silence, no clipped words.
const CROSSFADE_MS = 700;

export function VideoPlayer({ scenes }: { scenes: Scene[] }) {
  const masterAudioUrl = scenes[0]?.masterAudioUrl;
  const masterMode = !!masterAudioUrl;

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [prevScene, setPrevScene] = useState<Scene | null>(null);
  const [transitionPhase, setTransitionPhase] = useState<"idle" | "in">("idle");
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const prevIndexRef = useRef(0);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exportQuality, setExportQuality] = useState<RenderQuality | null>(null);
  const [exportProgress, setExportProgress] = useState(0);

  const scene = scenes[index];

  // Precompute scene time windows for master mode.
  const windows = useMemo(() => {
    if (!masterMode) return [] as { startMs: number; endMs: number }[];
    return scenes.map((s, i) => ({
      startMs: s.startMs ?? 0,
      endMs: s.endMs ?? (s.startMs ?? 0) + (s.durationMs || 4000),
    }));
  }, [scenes, masterMode]);

  async function handleExport(quality: RenderQuality) {
    if (exportQuality) return;
    setExportQuality(quality);
    setExportProgress(0);
    try {
      const blob = await renderVideo(scenes, quality, (p) => setExportProgress(p));
      const label = quality === "hd" ? "1080p60" : "preview";
      downloadBlob(blob, `explainer-${label}-${Date.now()}.webm`);
    } catch (e) {
      console.error("Export failed", e);
      alert("Export failed: " + (e as Error).message);
    } finally {
      setExportQuality(null);
      setExportProgress(0);
    }
  }

  // Visual crossfade on scene change (works in both modes).
  useEffect(() => {
    if (prevIndexRef.current !== index) {
      const p = scenes[prevIndexRef.current];
      prevIndexRef.current = index;
      if (p) {
        setPrevScene(p);
        setTransitionPhase("idle");
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setTransitionPhase("in"));
        });
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = setTimeout(() => {
          setPrevScene(null);
          setTransitionPhase("idle");
        }, CROSSFADE_MS);
      }
    }
  }, [index, scenes]);

  useEffect(() => () => {
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
  }, []);

  // Play/pause
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.play().catch(() => {});
      videoRef.current?.play().catch(() => {});
    } else {
      a.pause();
      videoRef.current?.pause();
    }
  }, [playing]);

  // Reset stock video on scene change
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      if (playing) videoRef.current.play().catch(() => {});
    }
  }, [index]);

  // ============ MASTER MODE: one continuous audio, timestamp-driven ============
  useEffect(() => {
    if (!masterMode) return;
    const a = audioRef.current;
    if (!a) return;

    const onTime = () => {
      const cur = a.currentTime * 1000;
      // Find the scene whose window contains `cur`.
      let target = index;
      for (let i = 0; i < windows.length; i++) {
        if (cur >= windows[i].startMs && cur < windows[i].endMs) {
          target = i;
          break;
        }
        if (i === windows.length - 1 && cur >= windows[i].endMs) target = i;
      }
      if (target !== index) setIndex(target);
      const w = windows[target];
      const dur = Math.max(1, w.endMs - w.startMs);
      setProgress(Math.max(0, Math.min(1, (cur - w.startMs) / dur)));
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(1);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnd);
    };
  }, [masterMode, windows, index]);

  // ============ PER-SCENE MODE (no master): reload audio per scene ============
  useEffect(() => {
    if (masterMode) return;
    setProgress(0);
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = 0;
    if (playing) a.play().catch(() => {});
  }, [index, masterMode, playing]);

  useEffect(() => {
    if (masterMode) return;
    const a = audioRef.current;
    if (!a) return;
    let advanced = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let sawPlaying = false;

    const advance = () => {
      if (advanced) return;
      advanced = true;
      if (watchdog) clearTimeout(watchdog);
      if (index < scenes.length - 1) setIndex(index + 1);
      else setPlaying(false);
    };
    const onTime = () => {
      if (a.duration && isFinite(a.duration)) {
        setProgress(Math.min(1, a.currentTime / a.duration));
      }
    };
    const onPlaying = () => { sawPlaying = true; };
    const onEnd = () => advance();
    const onError = () => { setProgress(1); advance(); };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("playing", onPlaying);
    a.addEventListener("ended", onEnd);
    a.addEventListener("error", onError);
    watchdog = setTimeout(() => {
      if (!sawPlaying) { setProgress(1); advance(); }
    }, 8000);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("playing", onPlaying);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("error", onError);
      if (watchdog) clearTimeout(watchdog);
    };
  }, [masterMode, index, scenes.length]);

  function seekToScene(i: number) {
    setIndex(i);
    setPlaying(true);
    if (masterMode && audioRef.current) {
      audioRef.current.currentTime = (windows[i]?.startMs ?? 0) / 1000;
    }
  }

  function restart() {
    setIndex(0);
    setProgress(0);
    if (masterMode && audioRef.current) audioRef.current.currentTime = 0;
    setPlaying(true);
  }

  // Master-mode continuous timeline math.
  const totalMs = masterMode
    ? windows[windows.length - 1]?.endMs ?? 1
    : scenes.reduce((a, s) => a + (s.durationMs || 0), 0) || 1;
  const currentMs = masterMode
    ? (windows[index]?.startMs ?? 0) + progress * ((windows[index]?.endMs ?? 0) - (windows[index]?.startMs ?? 0))
    : scenes.slice(0, index).reduce((a, s) => a + (s.durationMs || 0), 0) +
      progress * (scenes[index]?.durationMs || 0);
  const overallPct = Math.max(0, Math.min(100, (currentMs / totalMs) * 100));

  function seekToMs(ms: number) {
    if (masterMode && audioRef.current) {
      audioRef.current.currentTime = Math.max(0, Math.min(totalMs - 10, ms)) / 1000;
      setPlaying(true);
      return;
    }
    // Per-scene fallback: find scene at ms.
    let acc = 0;
    for (let i = 0; i < scenes.length; i++) {
      const d = scenes[i].durationMs || 0;
      if (ms < acc + d) return seekToScene(i);
      acc += d;
    }
    seekToScene(scenes.length - 1);
  }

  function onTimelineClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    seekToMs(frac * totalMs);
  }

  const fmt = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  if (!scene) return null;

  const audioSrc = masterMode ? masterAudioUrl! : scene.audioUrl;

  return (
    <div className="w-full">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border bg-white shadow-sm">
        {prevScene && (
          <div
            key={`prev-${prevScene.id}`}
            className="absolute inset-0 z-10"
            style={{
              opacity: transitionPhase === "in" ? 0 : 1,
              transform: transitionPhase === "in" ? "scale(1.03)" : "scale(1)",
              transition: `opacity ${CROSSFADE_MS}ms ease-in-out, transform ${CROSSFADE_MS}ms ease-in-out`,
              willChange: "opacity, transform",
            }}
          >
            <SceneStage scene={prevScene} progress={1} />
          </div>
        )}
        <div
          key={`cur-${scene.id}`}
          className="absolute inset-0"
          style={{ animation: `sceneIn ${CROSSFADE_MS}ms ease-out both` }}
        >
          <SceneStage scene={scene} progress={progress} videoRef={videoRef} />
        </div>

        <audio ref={audioRef} src={audioSrc} preload="auto" />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => setPlaying((p) => !p)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          onClick={restart}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border hover:bg-accent"
          aria-label="Restart"
        >
          <RotateCcw size={16} />
        </button>
        <div className="flex-1">
          <div className="flex gap-1">
            {scenes.map((s, i) => (
              <button
                key={s.id}
                onClick={() => seekToScene(i)}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  i < index ? "bg-primary" : i === index ? "bg-primary/60" : "bg-muted"
                }`}
                aria-label={`Scene ${i + 1}`}
              >
                {i === index && (
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${progress * 100}%` }}
                  />
                )}
              </button>
            ))}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Scene {index + 1} / {scenes.length}
            {masterMode && <span className="ml-2 opacity-70">· continuous audio</span>}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">
        <span className="mr-1 text-xs font-medium text-muted-foreground">Download:</span>
        <button
          onClick={() => handleExport("preview")}
          disabled={!!exportQuality}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {exportQuality === "preview" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Download size={12} />
          )}
          Current quality (720p 30fps)
        </button>
        <button
          onClick={() => handleExport("hd")}
          disabled={!!exportQuality}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {exportQuality === "hd" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Download size={12} />
          )}
          HD (1080p 60fps)
        </button>
        {exportQuality && (
          <div className="ml-2 flex items-center gap-2 text-xs text-muted-foreground">
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.round(exportProgress * 100)}%` }}
              />
            </div>
            {Math.round(exportProgress * 100)}% — recording in real time
          </div>
        )}
      </div>

      <style>{`
        @keyframes sceneIn {
          from { opacity: 0.001; transform: scale(1.04); filter: blur(6px); }
          to   { opacity: 1; transform: scale(1); filter: blur(0); }
        }
      `}</style>
    </div>
  );
}
