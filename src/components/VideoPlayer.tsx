import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, RotateCcw, Download, Loader2 } from "lucide-react";
import { CodeScene, type CodeVariant } from "./CodeScene";
import type { CompositionElement } from "@/lib/explainer.functions";
import { exportToMp4, downloadBlob, type ExportQuality } from "@/lib/ffmpeg-stitcher";
import {
  backgroundToCss,
  CARD_PADDING_FRAC,
  DEFAULT_BACKGROUND,
  type SceneBackground,
} from "@/lib/scene-background";
import { getTransparentUrl } from "@/lib/remove-white-bg";
import { layoutFor } from "@/lib/scene-layouts";
import { coverOpacityAt, type RevealCover } from "@/lib/build-reveal";



export interface ResolvedElement extends CompositionElement {
  mediaUrl: string;
}

export interface Scene {
  id: string;
  subtitle: string;
  kind: "image" | "stock" | "code";
  /** stock (legacy): video URL. New scenes never use this. */
  mediaUrl?: string;
  /** image: composited background + elements */
  backgroundUrl?: string;
  /** Hand-drawn topic title rendered at the top of an image scene. */
  title?: string;
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
  /** SAM-derived white covers overlaid on backgroundUrl; fade out to reveal
   *  the underlying image at the start of the scene. */
  revealCovers?: RevealCover[];
  /** Natural aspect (w/h) of backgroundUrl — needed to place covers on the
   *  object-contain draw rect. Defaults to 1.5 (composite is 1536x1024). */
  bgAspect?: number;
}

function RevealCoverLayer({
  covers,
  aspect,
  progress,
  durationMs,
}: {
  covers: RevealCover[];
  aspect: number;
  progress: number;
  durationMs: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!cw || !ch) return;
      const cr = cw / ch;
      let w: number, h: number;
      if (aspect > cr) { w = cw; h = cw / aspect; }
      else { h = ch; w = ch * aspect; }
      setRect({ x: (cw - w) / 2, y: (ch - h) / 2, w, h });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      {rect &&
        covers.map((c, i) => (
          <img
            key={c.id}
            src={c.pngUrl}
            alt=""
            style={{
              position: "absolute",
              left: rect.x + c.bbox.x * rect.w,
              top: rect.y + c.bbox.y * rect.h,
              width: c.bbox.w * rect.w,
              height: c.bbox.h * rect.h,
              opacity: coverOpacityAt(progress, i, covers.length, durationMs),
            }}
            draggable={false}
          />
        ))}
    </div>
  );
}

function ImageScene({
  scene,
  progress,
  background,
  transparentMap,
}: {
  scene: Scene;
  progress: number;
  background: SceneBackground;
  transparentMap: Map<string, string>;
}) {
  const t = progress;
  const customBg = background.kind !== "whiteboard";
  const videoBg = background.kind === "video" ? background.url : null;
  const bgStyle: React.CSSProperties =
    scene.animation === "kenburns-in"
      ? { transform: `scale(${1 + 0.08 * t})` }
      : scene.animation === "kenburns-out"
        ? { transform: `scale(${1.08 - 0.08 * t})` }
        : scene.animation === "slide-left"
          ? { transform: `translateX(${(0.5 - t) * 20}px) scale(1.04)` }
          : { transform: "scale(1.02)" };

  const padPct = customBg ? CARD_PADDING_FRAC * 100 : 0;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background: backgroundToCss(background) }}
    >
      {videoBg && (
        <video
          key={videoBg}
          src={videoBg}
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {/* Inner card: on custom bg we inset a white rounded card (like the reference).
          On whiteboard, we let the AI background fill edge-to-edge. */}
      <div
        className="absolute overflow-hidden"
        style={{
          inset: customBg ? `${padPct}%` : 0,
          borderRadius: customBg ? "1.25rem" : 0,
          background: customBg ? "#ffffff" : "transparent",
          boxShadow: customBg ? "0 10px 40px -12px rgba(0,0,0,0.25)" : "none",
        }}
      >
        {scene.backgroundUrl && (
          <>
            <img
              src={scene.backgroundUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-contain transition-transform duration-100 ease-linear"
              style={{ ...bgStyle, background: "#ffffff" }}
            />
            {scene.revealCovers && scene.revealCovers.length > 0 && (
              <RevealCoverLayer
                covers={scene.revealCovers}
                aspect={scene.bgAspect ?? 1.5}
                progress={progress}
                durationMs={scene.durationMs || 15000}
              />
            )}
          </>
        )}
        {(() => {
          const els = scene.elements ?? [];
          if (els.length === 0) return null;

          const layout = layoutFor(els.length);
          return els.map((el, i) => {
            // Prefer bbox from segmentation; fall back to grid layout.
            const pos = el.bbox
              ? {
                  x: el.bbox.x + el.bbox.w / 2,
                  y: el.bbox.y + el.bbox.h / 2,
                  w: el.bbox.w,
                  h: el.bbox.h,
                }
              : { ...(layout[i] ?? { x: el.x, y: el.y, w: el.w }), h: undefined as number | undefined };
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

            const src = transparentMap.get(el.mediaUrl) ?? el.mediaUrl;
            const useTransparent = transparentMap.has(el.mediaUrl);

            return (
              <div
                key={el.id}
                className="absolute select-none"
                style={{
                  left: `${pos.x * 100}%`,
                  top: `${pos.y * 100}%`,
                  width: `${pos.w * 100}%`,
                  ...(pos.h != null ? { height: `${pos.h * 100}%` } : { aspectRatio: "1 / 1" }),
                  transform: `translate(-50%, -50%) ${transform}`,
                  transformOrigin: "center center",
                  opacity,
                  pointerEvents: "none",
                }}
              >
                <img
                  src={src}
                  alt=""
                  className="block h-full w-full"
                  style={{
                    objectFit: "contain",
                    ...(useTransparent ? {} : { mixBlendMode: "multiply" as const }),
                  }}
                  draggable={false}
                  onError={() =>
                    console.error("[ImageScene] element image failed to load", {
                      sceneId: scene.id,
                      elId: el.id,
                      src: src?.slice(0, 80),
                    })
                  }
                />
                {el.label && (
                  <div
                    className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-center"
                    style={{
                      top: "calc(100% + 2px)",
                      fontFamily: '"Caveat", "Kalam", cursive',
                      fontWeight: 700,
                      fontSize: `${Math.max(12, pos.w * 50)}px`,
                      color: "#1a1a1a",
                      textShadow: "0 1px 0 rgba(255,255,255,0.9)",
                    }}
                  >
                    {el.label}
                  </div>
                )}
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}


function SceneStage({
  scene,
  progress,
  videoRef,
  background,
  transparentMap,
}: {
  scene: Scene;
  progress: number;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  background: SceneBackground;
  transparentMap: Map<string, string>;
}) {
  console.log("[SceneStage]", {
    id: scene.id,
    kind: scene.kind,
    codeLen: scene.code?.length ?? 0,
    codeVariant: scene.codeVariant ?? null,
    elements: (scene.elements ?? []).length,
    elementUrls: (scene.elements ?? []).map((e) => e.mediaUrl?.slice(0, 60)),
    bgUrl: scene.backgroundUrl?.slice(0, 60) ?? null,
    subtitle: scene.subtitle,
  });
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
    return (
      <ImageScene
        scene={scene}
        progress={progress}
        background={background}
        transparentMap={transparentMap}
      />
    );
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

export function VideoPlayer({
  scenes,
  background = DEFAULT_BACKGROUND,
}: {
  scenes: Scene[];
  background?: SceneBackground;
}) {

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
  const [exportQuality, setExportQuality] = useState<ExportQuality | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStage, setExportStage] = useState("");
  const [transparentMap, setTransparentMap] = useState<Map<string, string>>(new Map());

  // Only process element images when a custom background is chosen; the
  // whiteboard theme already sits on white, so multiply-blend handles it.
  useEffect(() => {
    if (background.kind === "whiteboard") {
      setTransparentMap(new Map());
      return;
    }
    let cancelled = false;
    const urls = new Set<string>();
    for (const s of scenes) {
      if (s.kind === "image") for (const e of s.elements ?? []) urls.add(e.mediaUrl);
    }
    (async () => {
      const next = new Map<string, string>();
      await Promise.all(
        Array.from(urls).map(async (u) => {
          const t = await getTransparentUrl(u);
          next.set(u, t);
        }),
      );
      if (!cancelled) setTransparentMap(next);
    })();
    return () => { cancelled = true; };
  }, [scenes, background.kind]);

  const scene = scenes[index];


  // Precompute scene time windows for master mode.
  const windows = useMemo(() => {
    if (!masterMode) return [] as { startMs: number; endMs: number }[];
    return scenes.map((s, i) => ({
      startMs: s.startMs ?? 0,
      endMs: s.endMs ?? (s.startMs ?? 0) + (s.durationMs || 4000),
    }));
  }, [scenes, masterMode]);

  async function handleExport(quality: ExportQuality) {
    if (exportQuality) return;
    setExportQuality(quality);
    setExportProgress(0);
    setExportStage("starting…");
    try {
      const blob = await exportToMp4(scenes, masterAudioUrl, quality, (stage, ratio) => {
        setExportStage(stage);
        setExportProgress(ratio);
      }, background);

      const label = quality === "hd" ? "1080p60" : "720p30";
      downloadBlob(blob, `explainer-${label}-${Date.now()}.mp4`);
    } catch (e) {
      console.error("Export failed", e);
      alert("Export failed: " + (e as Error).message);
    } finally {
      setExportQuality(null);
      setExportProgress(0);
      setExportStage("");
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
            <SceneStage
              scene={prevScene}
              progress={1}
              background={background}
              transparentMap={transparentMap}
            />
          </div>
        )}
        <div
          key={`cur-${scene.id}`}
          className="absolute inset-0"
          style={{ animation: `sceneIn ${CROSSFADE_MS}ms ease-out both` }}
        >
          <SceneStage
            scene={scene}
            progress={progress}
            videoRef={videoRef}
            background={background}
            transparentMap={transparentMap}
          />
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
          <div
            className="group relative h-2 w-full cursor-pointer rounded-full bg-muted"
            onClick={onTimelineClick}
            role="slider"
            aria-label="Timeline"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(overallPct)}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${overallPct}%` }}
            />
            {/* Scene tick marks */}
            {scenes.slice(1).map((_, i) => {
              const boundaryMs = masterMode
                ? windows[i]?.endMs ?? 0
                : scenes.slice(0, i + 1).reduce((a, s) => a + (s.durationMs || 0), 0);
              const left = (boundaryMs / totalMs) * 100;
              return (
                <div
                  key={i}
                  className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-background/80"
                  style={{ left: `${left}%` }}
                />
              );
            })}
            <div
              className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background opacity-0 shadow group-hover:opacity-100"
              style={{ left: `${overallPct}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Scene {index + 1} / {scenes.length}
              {masterMode && <span className="ml-2 opacity-70">· continuous audio</span>}
            </span>
            <span className="tabular-nums">{fmt(currentMs)} / {fmt(totalMs)}</span>
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
          <div className="ml-2 flex min-w-[240px] flex-1 items-center gap-2 text-xs text-muted-foreground">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.round(exportProgress * 100)}%` }}
              />
            </div>
            <span className="whitespace-nowrap tabular-nums">
              {Math.round(exportProgress * 100)}%
            </span>
            <span className="truncate opacity-80">{exportStage}</span>
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
