import { useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { CodeScene, type CodeVariant } from "./CodeScene";

export interface Scene {
  id: string;
  subtitle: string;
  kind: "image" | "stock" | "code";
  mediaUrl?: string;
  audioUrl: string;
  durationMs: number;
  animation: "kenburns-in" | "kenburns-out" | "fade" | "slide-left";
  code?: string;
  codeTo?: string;
  codeLanguage?: string;
  codeVariant?: CodeVariant;
}

export function VideoPlayer({ scenes }: { scenes: Scene[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const scene = scenes[index];

  useEffect(() => {
    setProgress(0);
    if (!scene) return;
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = 0;
    if (playing) a.play().catch(() => {});
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      if (playing) videoRef.current.play().catch(() => {});
    }
  }, [index, scene?.id]);

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

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      if (a.duration) setProgress(a.currentTime / a.duration);
    };
    const onEnd = () => {
      if (index < scenes.length - 1) setIndex(index + 1);
      else setPlaying(false);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnd);
    };
  }, [index, scenes.length]);

  if (!scene) return null;

  const t = progress;
  const kenIn = { transform: `scale(${1 + 0.15 * t})`, opacity: 1 };
  const kenOut = { transform: `scale(${1.15 - 0.15 * t})`, opacity: 1 };
  const fade = {
    opacity: t < 0.1 ? t / 0.1 : t > 0.9 ? (1 - t) / 0.1 : 1,
    transform: "scale(1)",
  };
  const slide = { transform: `translateX(${(0.5 - t) * 40}px) scale(1.05)`, opacity: 1 };
  const style =
    scene.animation === "kenburns-in"
      ? kenIn
      : scene.animation === "kenburns-out"
        ? kenOut
        : scene.animation === "slide-left"
          ? slide
          : fade;

  return (
    <div className="w-full">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border bg-white shadow-sm">
        <div className="absolute inset-0 flex items-center justify-center">
          {scene.kind === "code" ? (
            <CodeScene
              code={scene.code ?? ""}
              codeTo={scene.codeTo}
              language={scene.codeLanguage}
              variant={scene.codeVariant ?? "typing"}
              progress={progress}
            />
          ) : scene.kind === "image" ? (
            <img
              src={scene.mediaUrl}
              alt=""
              className="h-full w-full object-contain transition-transform"
              style={{ ...style, transitionDuration: "80ms" }}
            />
          ) : (
            <video
              ref={videoRef}
              src={scene.mediaUrl}
              muted
              playsInline
              className="h-full w-full object-cover"
            />
          )}
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-6">
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
    </div>
  );
}
