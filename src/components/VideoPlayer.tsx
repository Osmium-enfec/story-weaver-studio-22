import { useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { CodeScene, type CodeVariant } from "./CodeScene";
import type { CompositionElement } from "@/lib/explainer.functions";

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
  audioUrl: string;
  durationMs: number;
  animation: "kenburns-in" | "kenburns-out" | "fade" | "slide-left";
  code?: string;
  codeTo?: string;
  codeLanguage?: string;
  codeVariant?: CodeVariant;
}

/** Renders a single image scene: background + elements revealed one-by-one. */
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
        const shown = t >= el.appearAt;
        // Local progress since element appeared, 0..1 across ~450ms window (approx via scene duration)
        const revealWindow = Math.max(0.02, 450 / Math.max(1, scene.durationMs));
        const p = shown ? Math.min(1, (t - el.appearAt) / revealWindow) : 0;
        const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic

        let transform = "";
        let opacity = eased;
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

        return (
          <img
            key={el.id}
            src={el.mediaUrl}
            alt=""
            className="absolute select-none"
            style={{
              left: `${el.x * 100}%`,
              top: `${el.y * 100}%`,
              width: `${el.w * 100}%`,
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

// Timing knobs for scene syncing:
// - INTER_SCENE_GAP_MS: silent breath between scenes so voice feels natural.
// - CROSSFADE_MS: how long the outgoing scene overlaps the incoming one.
// - PLAYBACK_RATE: <1 slows narration slightly for a calmer pace.
const INTER_SCENE_GAP_MS = 550;
const CROSSFADE_MS = 750;
const PLAYBACK_RATE = 0.95;

export function VideoPlayer({ scenes }: { scenes: Scene[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [prevScene, setPrevScene] = useState<Scene | null>(null);
  const [transitionPhase, setTransitionPhase] = useState<"idle" | "in">("idle");
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const prevIndexRef = useRef(0);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scene = scenes[index];

  // Scene change: snapshot previous scene and crossfade it out while new fades in.
  useEffect(() => {
    if (prevIndexRef.current !== index) {
      const p = scenes[prevIndexRef.current];
      prevIndexRef.current = index;
      if (p) {
        setPrevScene(p);
        setTransitionPhase("idle");
        // Next frame → flip to "in" so CSS transition animates.
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

  useEffect(() => {
    setProgress(0);
    if (!scene) return;
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = 0;
    a.playbackRate = PLAYBACK_RATE;
    if (playing) a.play().catch(() => {});
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      if (playing) videoRef.current.play().catch(() => {});
    }
  }, [index, scene?.id]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = PLAYBACK_RATE;
    if (playing) {
      a.play().catch(() => {});
      videoRef.current?.play().catch(() => {});
    } else {
      a.pause();
      videoRef.current?.pause();
    }
  }, [playing]);

  useEffect(() => () => {
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      if (a.duration) setProgress(a.currentTime / a.duration);
    };
    const onEnd = () => {
      if (index < scenes.length - 1) {
        // Small silent breath between scenes so voice feels natural.
        if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = setTimeout(() => setIndex(index + 1), INTER_SCENE_GAP_MS);
      } else {
        setPlaying(false);
      }
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnd);
    };
  }, [index, scenes.length]);

  if (!scene) return null;

  return (
    <div className="w-full">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border bg-white shadow-sm">
        {/* Previous scene sits on top and fades out over CROSSFADE_MS */}
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
        {/* Current scene underneath, gently scaling in */}
        <div
          key={`cur-${scene.id}`}
          className="absolute inset-0"
          style={{
            animation: `sceneIn ${CROSSFADE_MS}ms ease-out both`,
          }}
        >
          <SceneStage scene={scene} progress={progress} videoRef={videoRef} />
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-6">
          <p className="text-center text-lg font-medium text-white drop-shadow">
            {scene.subtitle}
          </p>
        </div>
        <audio ref={audioRef} src={scene.audioUrl} preload="auto" />
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
          onClick={() => {
            setIndex(0);
            setProgress(0);
            setPlaying(true);
          }}
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
                onClick={() => {
                  setIndex(i);
                  setPlaying(true);
                }}
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
          </div>
        </div>
      </div>

      <style>{`
        @keyframes sceneIn {
          from { opacity: 0; transform: scale(1.02); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
