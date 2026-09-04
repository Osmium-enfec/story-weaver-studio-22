import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Play, Pause, RotateCcw, Download, Loader2 } from "lucide-react";
import { CodeScene, type CodeVariant } from "./CodeScene";
import type { CodeTypingBeat } from "@/lib/code-scene-sfx";
import {
  CODE_TYPING_SFX,
  DEFAULT_CODE_TYPING_CPS,
  buildCodeBeatTimeline,
  resolveCodeBeatFrame,
  resolveCodeTypingBeats,
  isTypingInProgress,
} from "@/lib/code-scene-sfx";
import { QuestionScene, MarkYourAnswersScreen, QuestionIntroScreen } from "./QuestionScene";
import { TemplateScene } from "./TemplateScene";
import {
  sceneToQuestionContent,
  questionMarkSettingsFromScene,
  questionIntroSettingsFromScene,
  questionPostSpeechVisualMs,
  questionPreQuestionMs,
  questionMarkCountdownMs,
  questionIntroGapMs,
  questionTimelineAt,
  questionPostSpeechAt,
  markCountdownSeconds,
  type QuestionDisplayPhase,
} from "@/lib/question-scene-layout";
import type { CompositionElement } from "@/lib/explainer.functions";
import { startNativeExportJob } from "@/lib/native-export-client";
import type { ExportQuality } from "@/lib/ffmpeg-stitcher";
import {
  backgroundToCss,
  CARD_PADDING_FRAC,
  DEFAULT_BACKGROUND,
  type SceneBackground,
} from "@/lib/scene-background";
import { getTransparentUrl } from "@/lib/remove-white-bg";
import { layoutFor } from "@/lib/scene-layouts";
import { type RevealCover } from "@/lib/build-reveal";
import {
  recordingCameraAt,
  recordingCameraDrawRects,
  recordingCameraVideoLayout,
  recordingCameraZoomEvents,
  recordingCameraZoomSfxUrl,
} from "@/lib/recording-camera";
import {
  blurRadiusForStrength,
  normalizeRecordingBlurRegion,
  sourceBlurRectToView,
} from "@/lib/recording-blur";
import {
  handDrawnRectPathD,
  highlightAnimAtMs,
  highlightStrokeWidth,
  normalizeRecordingHighlights,
  sourceHighlightRectToView,
} from "@/lib/recording-highlight";
import {
  detectAndCacheVideoContentCrop,
  type VideoContentCrop,
} from "@/lib/video-black-bars";
import { expandBboxForReveal } from "@/lib/bbox-utils";
import { COMPOSITE_ASPECT } from "@/lib/course-visual-style";
import { isCropOnlyScene } from "@/lib/compose-scene";
import { boxRevealOpacityAtMs, revealSpeechDurationMs } from "@/lib/reveal-schedule";
import {
  masterVisualAt,
  sceneGapMs,
  sceneHoldMs,
  sceneTransitionMs,
  slideOffset,
  type MasterVisualState,
} from "@/lib/scene-transition";
import { EXCALIFONT_STACK } from "@/lib/scene-font";
import type { PartBgmConfig } from "@/lib/part-bgm";
import { partBgmVolumeAtMs, resolvePartBgm } from "@/lib/part-bgm";
import { bgmMuteRangesMs } from "@/lib/common-intro-outro";
import {
  recordingAudioRateAtClock,
  recordingAudioSourceTimeSec,
  recordingClockMsFromAudioSourceSec,
} from "@/lib/recording-audio-layout";
import { recordingVideoAtClock } from "@/lib/rasterize-scene";



export interface ResolvedElement extends CompositionElement {
  mediaUrl: string;
}

export interface Scene {
  id: string;
  subtitle: string;
  kind: "image" | "stock" | "code" | "question" | "template" | "recording";
  /** stock (legacy) or recording: video URL. */
  mediaUrl?: string;
  /** recording: trim in/out on the source video (ms). */
  recordingTrimStartMs?: number;
  recordingTrimEndMs?: number;
  /** recording: delay video relative to scene clock (ms; may be negative). */
  recordingVideoOffsetMs?: number;
  /** recording: full source video duration before trim (ms). */
  recordingSourceDurationMs?: number;
  /** recording: trim in/out on TTS source (ms). Legacy single-clip fields. */
  recordingAudioTrimStartMs?: number;
  recordingAudioTrimEndMs?: number;
  /** recording: delay trimmed narration on scene timeline (ms). */
  recordingAudioOffsetMs?: number;
  /** recording: full TTS length before trim (ms). */
  recordingAudioSourceDurationMs?: number;
  /**
   * recording: one or more narration slices placed on the timeline.
   * Prefer this over the single-clip fields when present.
   */
  recordingAudioSegments?: Array<{
    id: string;
    trimStartMs: number;
    trimEndMs: number;
    offsetMs: number;
    rate?: number;
  }>;
  /**
   * recording: one or more video slices on the timeline.
   * Prefer this over recordingTrim* / recordingVideoOffsetMs when present.
   */
  recordingVideoSegments?: Array<{
    id: string;
    trimStartMs: number;
    trimEndMs: number;
    offsetMs: number;
    rate?: number;
  }>;
  /**
   * recording: pan/zoom camera keyframes on the scene clock.
   * Interpolated in preview + export via recording-camera.ts.
   */
  recordingCameraKeyframes?: Array<{
    atMs: number;
    scale: number;
    focusX: number;
    focusY: number;
    easing?: "linear" | "easeInOut";
  }>;
  /** How long a zoom in/out move lasts when authored (ms). */
  recordingCameraZoomDurationMs?: number;
  /** One-shot SFX when a zoom move starts. */
  recordingCameraZoomSfx?: "swoosh" | "none";
  /** recording: audio was demuxed from the video (clip mode — no TTS/sync). */
  recordingUseEmbeddedAudio?: boolean;
  /** recording: Screen recording 2 auto voice-replace pipeline. */
  recordingVoiceReplace?: boolean;
  /** recording: blur region in source space (tracks through camera zoom). */
  recordingBlurRegion?: {
    x: number;
    y: number;
    w: number;
    h: number;
    strength: number;
  };
  /** recording: timed hand-drawn rectangle highlights. */
  recordingHighlights?: Array<{
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    atMs: number;
    drawMs: number;
  }>;
  /** image: composited background + elements */
  backgroundUrl?: string;
  /** Thumbnail source for compose scenes (not shown during crop-only playback). */
  compositeThumbUrl?: string;
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
  /** Characters per second for timed code typing (optional). */
  codeTypingCps?: number;
  /** Version 2 scenes use the 15 cps default and preserve explicit values such as 28. */
  codeTypingDefaultsVersion?: number;
  /** Monospace code font size in px (optional; default ~14). */
  codeFontSize?: number;
  /** Console output shown after Run (user-authored; not executed). Legacy single-step. */
  codeOutput?: string;
  /** Delay after typing finishes before Run is pressed (ms). Legacy single-step. */
  codeRunDelayMs?: number;
  /** How long to show output after Run (ms). Legacy single-step. */
  codeOutputHoldMs?: number;
  /**
   * Multi-step type → run → output cycles. Each beat appends more code.
   * When set, overrides flat codeOutput / codeRunDelayMs / codeOutputHoldMs.
   */
  codeTypingBeats?: CodeTypingBeat[];
  /** Scene has no voiceover — silent bed + BGM / typing SFX only. */
  silentNarration?: boolean;
  /** MCQ / MSQ / coding / predict-output question scene (code-rendered, not AI image). */
  questionKind?: "mcq" | "msq" | "coding" | "predictOutput";
  questionText?: string;
  questionSubtitle?: string;
  questionOptions?: string[];
  questionCorrect?: string[];
  /** Predict-output: code block between question and options. */
  questionCode?: string;
  /** Predict-output: MCQ vs MSQ option style. */
  predictSelectMode?: "mcq" | "msq";
  /** Coding-problem layout fields. */
  codingTitle?: string;
  codingStarterCode?: string;
  codingTestCases?: { label: string; input: string; output: string }[];
  /** Countdown page copy + timing after question narration. */
  questionMarkText?: string;
  questionMarkGapMs?: number;
  questionMarkCountdownSec?: number;
  questionMarkAudioUrl?: string;
  /** Probed length of questionMarkAudioUrl (ms) — extends post-speech hold when longer than countdown. */
  questionMarkDurationMs?: number;
  /** Intro screen before the question card (voiceover + gap). */
  questionIntroText?: string;
  questionIntroGapMs?: number;
  questionIntroAudioUrl?: string;
  questionIntroDurationMs?: number;
  /** White-bg Excalifont templates (text / typing / countdown) or template code typing. */
  templateKind?: "text" | "countdown" | "typing" | "codeTyping";
  templateText?: string;
  templateColor?: string;
  templateFontSize?: number;
  templateCountdownSec?: number;
  /** Locked built-in template card (try-question / try-coding). */
  templateFixedPreset?: "try-question" | "try-coding";
  /**
   * When set, the whole video shares ONE continuous audio track and
   * this scene occupies [startMs, endMs] of it. All scenes in a set
   * must carry the same masterAudioUrl.
   */
  masterAudioUrl?: string;
  startMs?: number;
  endMs?: number;
  /** Hold after speech before slide (ms). Set when master track is stitched. */
  holdMs?: number;
  /** Slide + whoosh duration (ms) after this scene (stitched). */
  transitionMs?: number;
  /** Inter-scene visual effect (default: right-to-left swap). */
  transitionEffect?: "slide-left";
  /**
   * Authored transition AFTER this scene to the next.
   * Survives edit/re-stitch; ignored on the last scene.
   */
  outTransition?: {
    holdMs: number;
    durationMs: number;
    effect: "slide-left";
    sfxId: "swoosh";
    sfxVolume: number;
  };
  /** Narration spoken during this scene — used to sync box reveals to words. */
  narrationText?: string;
  /** Detected hand-drawn boxes; each fades in on its scheduled turn. */
  revealCovers?: RevealCover[];
  /** Natural aspect (w/h) of backgroundUrl — needed to place covers on the
   *  object-contain draw rect. Defaults to 3:2 (composite is 1536×1024). */
  bgAspect?: number;
  /** When using a long uploaded track, only this clip window is spoken for the scene. */
  audioClipStartMs?: number;
  audioClipEndMs?: number;
}

/** Each box is a clipped crop of the composite — opacity 0 until its turn. */
function RevealBoxLayers({
  imageUrl,
  covers,
  elapsedSpeechMs,
}: {
  imageUrl: string;
  covers: RevealCover[];
  elapsedSpeechMs: number;
}) {
  return (
    <>
      <div className="absolute inset-0 bg-white" aria-hidden />
      {covers.map((c, i) => {
        const opacity = boxRevealOpacityAtMs(elapsedSpeechMs, i, covers);
        if (opacity <= 0) return null;
        const { x, y, w, h } = expandBboxForReveal(c.bbox);
        return (
          <div
            key={c.id}
            className="absolute overflow-hidden"
            style={{
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: `${w * 100}%`,
              height: `${h * 100}%`,
              opacity,
              pointerEvents: "none",
            }}
          >
            <img
              src={imageUrl}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                width: `${100 / w}%`,
                height: `${100 / h}%`,
                left: `${-(x / w) * 100}%`,
                top: `${-(y / h) * 100}%`,
                maxWidth: "none",
              }}
            />
          </div>
        );
      })}
    </>
  );
}

function SceneBackgroundLayer({ background }: { background: SceneBackground }) {
  const videoBg = background.kind === "video" ? background.url : null;
  return (
    <div
      className="absolute inset-0 overflow-hidden"
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
    </div>
  );
}

function ImageScene({
  scene,
  progress,
  elapsedSpeechMs,
  background,
  transparentMap,
  contentOnly = false,
}: {
  scene: Scene;
  progress: number;
  elapsedSpeechMs: number;
  background: SceneBackground;
  transparentMap: Map<string, string>;
  contentOnly?: boolean;
}) {
  const t = progress;
  const customBg = background.kind !== "whiteboard";
  const videoBg = background.kind === "video" ? background.url : null;
  const hasReveal = (scene.revealCovers?.length ?? 0) > 0;
  const cropOnly = isCropOnlyScene(scene);
  const showFullBackground = !!scene.backgroundUrl && !cropOnly && !hasReveal;
  const useAspectFrame = !!scene.backgroundUrl || cropOnly;
  const aspect = scene.bgAspect ?? COMPOSITE_ASPECT;
  const containerRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const padPct = customBg ? CARD_PADDING_FRAC * 100 : 0;
  const els = scene.elements ?? [];
  const playedSfxRef = useRef<Set<string>>(new Set());
  const prevProgressRef = useRef(0);

  useEffect(() => {
    playedSfxRef.current.clear();
    prevProgressRef.current = 0;
  }, [scene.id]);

  useEffect(() => {
    const prev = prevProgressRef.current;
    const curr = progress;
    prevProgressRef.current = curr;
    if (curr < prev - 0.01) playedSfxRef.current.clear();

    for (const el of els) {
      if (!el.sfxUrl) continue;
      if (prev < el.appearAt && curr >= el.appearAt && !playedSfxRef.current.has(el.id)) {
        playedSfxRef.current.add(el.id);
        const sfx = new Audio(el.sfxUrl);
        sfx.volume = 0.85;
        void sfx.play().catch(() => {});
      }
    }
  }, [progress, els]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!cw || !ch) return;
      const cr = cw / ch;
      let w: number;
      let h: number;
      if (aspect > cr) {
        w = cw;
        h = cw / aspect;
      } else {
        h = ch;
        w = ch * aspect;
      }
      setFit({ w, h });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, useAspectFrame]);

  function renderElements() {
    if (els.length === 0) return null;
    const layout = layoutFor(els.length);
    return els.map((el, i) => {
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
          {el.label && !el.bbox && (
            <div
              className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-center"
              style={{
                top: "calc(100% + 2px)",
                fontFamily: EXCALIFONT_STACK,
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
  }

  const card = (
      <div
        className="absolute overflow-hidden"
        style={{
          inset: customBg ? `${padPct}%` : 0,
          borderRadius: customBg ? "1.25rem" : 0,
          background: customBg ? "#ffffff" : "transparent",
          boxShadow: customBg ? "0 10px 40px -12px rgba(0,0,0,0.25)" : "none",
        }}
      >
        {useAspectFrame ? (
          <div ref={containerRef} className="absolute inset-0 flex items-center justify-center">
            {!fit && <div className="absolute inset-0 bg-white" />}
            {fit && (
              <div
                className="relative bg-white"
                style={{ width: fit.w, height: fit.h }}
              >
                {hasReveal && scene.backgroundUrl && (
                  <RevealBoxLayers
                    imageUrl={scene.backgroundUrl}
                    covers={scene.revealCovers!}
                    elapsedSpeechMs={elapsedSpeechMs}
                  />
                )}
                {showFullBackground && (
                  <img
                    src={scene.backgroundUrl}
                    alt=""
                    className="block h-full w-full object-contain"
                    draggable={false}
                  />
                )}
                {renderElements()}
              </div>
            )}
          </div>
        ) : (
          renderElements()
        )}
      </div>
  );

  if (contentOnly) {
    return <div className="relative h-full w-full overflow-hidden">{card}</div>;
  }

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
      {card}
    </div>
  );
}


function QuestionSceneStage({
  scene,
  progress,
  background,
  questionPhase = "question",
  markHoldElapsedMs = 0,
  contentOnly = false,
}: {
  scene: Scene;
  progress: number;
  background: SceneBackground;
  questionPhase?: QuestionDisplayPhase;
  markHoldElapsedMs?: number;
  contentOnly?: boolean;
}) {
  const content = sceneToQuestionContent(scene);
  const markSettings = questionMarkSettingsFromScene(scene);
  const introSettings = questionIntroSettingsFromScene(scene);
  const customBg = background.kind !== "whiteboard";
  const videoBg = background.kind === "video" ? background.url : null;
  const padPct = customBg ? CARD_PADDING_FRAC * 100 : 0;

  if (!content) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white text-sm text-muted-foreground">
        Question data missing
      </div>
    );
  }

  const card = (
      <div
        className="absolute overflow-hidden"
        style={{
          inset: customBg ? `${padPct}%` : 0,
          borderRadius: customBg ? "1.25rem" : 0,
          background: customBg ? "#ffffff" : "transparent",
          boxShadow: customBg ? "0 10px 40px -12px rgba(0,0,0,0.25)" : "none",
        }}
      >
        {questionPhase === "mark" ? (
          <MarkYourAnswersScreen
            embedded
            markText={markSettings.text}
            secondsLeft={markCountdownSeconds(
              markHoldElapsedMs,
              markSettings.countdownMs,
            )}
            holdSeconds={markSettings.countdownMs / 1000}
          />
        ) : questionPhase === "intro" || questionPhase === "intro-gap" ? (
          <QuestionIntroScreen embedded introText={introSettings.text} />
        ) : (
          <QuestionScene content={content} progress={questionPhase === "mark-gap" ? 1 : progress} embedded />
        )}
      </div>
  );

  if (contentOnly) {
    return <div className="relative h-full w-full overflow-hidden">{card}</div>;
  }

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
      {card}
    </div>
  );
}

function CodeSceneStage({
  scene,
  progress,
  background,
  playing,
  contentOnly = false,
}: {
  scene: Scene;
  progress: number;
  background: SceneBackground;
  playing: boolean;
  contentOnly?: boolean;
}) {
  const typingAudioRef = useRef<HTMLAudioElement | null>(null);
  const customBg = background.kind !== "whiteboard";
  const videoBg = background.kind === "video" ? background.url : null;
  const padPct = customBg ? CARD_PADDING_FRAC * 100 : 0;
  const variant = scene.codeVariant ?? "typing";
  const cps =
    scene.codeTypingDefaultsVersion !== 2 && scene.codeTypingCps === 28
      ? DEFAULT_CODE_TYPING_CPS
      : (scene.codeTypingCps ?? DEFAULT_CODE_TYPING_CPS);
  const timeline = useMemo(() => {
    if ((scene.codeVariant ?? "typing") !== "typing") return null;
    const beats = resolveCodeTypingBeats({
      beats: scene.codeTypingBeats,
      code: scene.code,
      output: scene.codeOutput,
      runDelayMs: scene.codeRunDelayMs,
      outputHoldMs: scene.codeOutputHoldMs,
    });
    if (!beats.length) return null;
    return buildCodeBeatTimeline(beats, cps);
  }, [
    scene.codeVariant,
    scene.codeTypingBeats,
    scene.code,
    scene.codeOutput,
    scene.codeRunDelayMs,
    scene.codeOutputHoldMs,
    cps,
  ]);
  const elapsedMs = progress * Math.max(1, scene.durationMs);
  const beatFrame =
    timeline != null ? resolveCodeBeatFrame(elapsedMs, timeline, cps) : null;
  const code = scene.code ?? "";
  const typingOpts = {
    cps,
    durationMs: scene.durationMs,
  };

  useEffect(() => {
    return () => {
      typingAudioRef.current?.pause();
      typingAudioRef.current = null;
    };
  }, [scene.id]);

  useEffect(() => {
    if (variant !== "typing") {
      typingAudioRef.current?.pause();
      return;
    }
    const shouldPlay = playing && (
      beatFrame
        ? beatFrame.typingActive
        : isTypingInProgress(code, progress, typingOpts)
    );
    if (!shouldPlay) {
      typingAudioRef.current?.pause();
      return;
    }
    let el = typingAudioRef.current;
    if (!el) {
      el = new Audio(CODE_TYPING_SFX);
      el.loop = true;
      el.volume = 0.42;
      typingAudioRef.current = el;
    }
    if (el.paused) void el.play().catch(() => {});
  }, [
    variant,
    code,
    progress,
    playing,
    scene.id,
    scene.codeTypingCps,
    scene.durationMs,
    beatFrame?.typingActive,
  ]);

  const card = (
      <div
        className="absolute overflow-hidden"
        style={{
          inset: customBg ? `${padPct}%` : 0,
          borderRadius: customBg ? "1.25rem" : 0,
          background: customBg ? "#ffffff" : "transparent",
          boxShadow: customBg ? "0 10px 40px -12px rgba(0,0,0,0.25)" : "none",
        }}
      >
        <CodeScene
          code={scene.code ?? ""}
          codeTo={scene.codeTo}
          language={scene.codeLanguage}
          variant={scene.codeVariant ?? "typing"}
          progress={progress}
          title={scene.subtitle}
          embedded
          typingSpeedCps={cps}
          durationMs={scene.durationMs}
          codeOutput={scene.codeOutput}
          codeRunDelayMs={scene.codeRunDelayMs}
          codeOutputHoldMs={scene.codeOutputHoldMs}
          codeTypingBeats={scene.codeTypingBeats}
          fontSizePx={scene.codeFontSize}
        />
      </div>
  );

  if (contentOnly) {
    return <div className="relative h-full w-full overflow-hidden">{card}</div>;
  }

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
      {card}
    </div>
  );
}

/** Screen recording inside the white card; video is muted and clock-synced to TTS. */
function RecordingSceneStage({
  scene,
  elapsedSpeechMs,
  background,
  contentOnly = false,
  playing = false,
}: {
  scene: Scene;
  elapsedSpeechMs: number;
  background: SceneBackground;
  contentOnly?: boolean;
  playing?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const zoomSfxRef = useRef<HTMLAudioElement | null>(null);
  const lastZoomSfxStartRef = useRef<number | null>(null);
  const customBg = background.kind !== "whiteboard";
  const videoBg = background.kind === "video" ? background.url : null;
  /** Stretch over loop BG after cropping baked black/white mattes. */
  const padPct = customBg ? CARD_PADDING_FRAC * 100 : 0;
  /** All recordings/clips: crop baked mattes, then stretch edge-to-edge (no black bars). */
  const cameraFit = "fill" as const;
  const cam = recordingCameraAt(scene.recordingCameraKeyframes, elapsedSpeechMs);
  const zoomSfxUrl = recordingCameraZoomSfxUrl(scene.recordingCameraZoomSfx);
  const blurRegion = normalizeRecordingBlurRegion(scene.recordingBlurRegion);
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [contentCrop, setContentCrop] = useState<VideoContentCrop | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !scene.mediaUrl) return;
    const { sourceSec, rate } = recordingVideoAtClock(scene, elapsedSpeechMs);
    if (Math.abs(v.currentTime - sourceSec) > 0.12) {
      try {
        v.currentTime = sourceSec;
      } catch {
        /* ignore seek errors while metadata loads */
      }
    }
    if (Math.abs(v.playbackRate - rate) > 0.001) {
      try {
        v.playbackRate = rate;
      } catch {
        /* ignore */
      }
    }
  }, [elapsedSpeechMs, scene]);

  useEffect(() => {
    if (!playing) {
      lastZoomSfxStartRef.current = null;
      return;
    }
    if (!zoomSfxUrl) return;
    const events = recordingCameraZoomEvents(scene.recordingCameraKeyframes);
    const hit = events.find(
      (ev) => elapsedSpeechMs >= ev.startMs && elapsedSpeechMs < ev.startMs + 80,
    );
    if (!hit) return;
    if (lastZoomSfxStartRef.current === hit.startMs) return;
    lastZoomSfxStartRef.current = hit.startMs;
    const el = zoomSfxRef.current;
    if (!el) return;
    el.src = zoomSfxUrl;
    el.currentTime = 0;
    el.volume = 0.75;
    void el.play().catch(() => {});
  }, [playing, elapsedSpeechMs, scene.recordingCameraKeyframes, zoomSfxUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setContentCrop(null);
    let onReady: (() => void) | null = null;
    const sync = () => {
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setVideoSize({ w: v.videoWidth, h: v.videoHeight });
        // Matte crop removes baked black bars for every recording/clip.
        if (!scene.mediaUrl) {
          setContentCrop(null);
          return;
        }
        const run = () => {
          try {
            const crop = detectAndCacheVideoContentCrop(
              scene.mediaUrl!,
              v,
              v.videoWidth,
              v.videoHeight,
            );
            setContentCrop(crop);
          } catch {
            setContentCrop({
              x: 0,
              y: 0,
              w: v.videoWidth,
              h: v.videoHeight,
            });
          }
        };
        if (v.readyState >= 2) run();
        else {
          onReady = () => {
            if (onReady) v.removeEventListener("loadeddata", onReady);
            onReady = null;
            run();
          };
          v.addEventListener("loadeddata", onReady);
        }
      }
    };
    sync();
    v.addEventListener("loadedmetadata", sync);
    return () => {
      v.removeEventListener("loadedmetadata", sync);
      if (onReady) v.removeEventListener("loadeddata", onReady);
    };
  }, [scene.mediaUrl]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setStageSize({ w: r.width, h: r.height });
      }
    });
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const cameraView = useMemo(() => {
    if (!videoSize.w || !videoSize.h || !stageSize.w || !stageSize.h) return null;
    // Crop baked mattes then stretch to fill (no letterboxing).
    const crop =
      contentCrop ?? {
        x: 0,
        y: 0,
        w: videoSize.w,
        h: videoSize.h,
      };
    const local = recordingCameraDrawRects(
      crop.w,
      crop.h,
      0,
      0,
      stageSize.w,
      stageSize.h,
      cam,
      cameraFit,
    );
    if (!local) return null;
    const rects = {
      ...local,
      sx: crop.x + local.sx,
      sy: crop.y + local.sy,
    };
    return {
      rects,
      videoLayout: recordingCameraVideoLayout(
        videoSize.w,
        videoSize.h,
        rects,
        cameraFit,
      ),
    };
  }, [videoSize, stageSize, cam, cameraFit, contentCrop]);

  const blurView = useMemo(() => {
    if (!blurRegion || !cameraView) return null;
    const view = sourceBlurRectToView(
      blurRegion,
      videoSize.w,
      videoSize.h,
      cameraView.rects,
    );
    if (!view) return null;
    return {
      ...view,
      radius: blurRadiusForStrength(
        blurRegion.strength,
        Math.min(view.width, view.height),
      ),
    };
  }, [blurRegion, cameraView, videoSize]);

  const highlightViews = useMemo(() => {
    const highlights = normalizeRecordingHighlights(scene.recordingHighlights);
    if (!cameraView || !highlights.length || !videoSize.w || !videoSize.h) return [];
    const out: Array<{
      id: string;
      color: string;
      left: number;
      top: number;
      width: number;
      height: number;
      pathD: string;
      strokeProgress: number;
      opacity: number;
    }> = [];
    for (const h of highlights) {
      const anim = highlightAnimAtMs(h, elapsedSpeechMs);
      if (!anim.active) continue;
      const view = sourceHighlightRectToView(h, videoSize.w, videoSize.h, cameraView.rects);
      if (!view) continue;
      out.push({
        id: h.id,
        color: h.color,
        ...view,
        pathD: handDrawnRectPathD(view.left, view.top, view.width, view.height, h.id),
        strokeProgress: anim.strokeProgress,
        opacity: anim.opacity,
      });
    }
    return out;
  }, [scene.recordingHighlights, cameraView, videoSize, elapsedSpeechMs]);

  const card = (
    <div
      className="absolute overflow-hidden"
      style={{
        inset: customBg ? `${padPct}%` : 0,
        borderRadius: customBg ? "1.25rem" : 0,
        // Transparent so the orange loop BG shows up to the video edge.
        background: "transparent",
        boxShadow: "none",
      }}
    >
      <audio ref={zoomSfxRef} preload="auto" className="hidden" />
      {scene.mediaUrl ? (
        <div
          ref={stageRef}
          className="absolute inset-0 overflow-hidden bg-transparent"
        >
          <video
            ref={videoRef}
            src={scene.mediaUrl}
            muted
            playsInline
            preload="auto"
            className="absolute max-w-none bg-transparent"
            style={
              cameraView
                ? {
                    left: cameraView.videoLayout.left,
                    top: cameraView.videoLayout.top,
                    width: cameraView.videoLayout.width,
                    height: cameraView.videoLayout.height,
                    objectFit: "fill",
                  }
                : {
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "fill",
                  }
            }
          />
          {blurView && blurView.radius > 0 && (
            <div
              className="pointer-events-none absolute"
              style={{
                left: blurView.left,
                top: blurView.top,
                width: blurView.width,
                height: blurView.height,
                backdropFilter: `blur(${blurView.radius}px)`,
                WebkitBackdropFilter: `blur(${blurView.radius}px)`,
              }}
              aria-hidden
            />
          )}
          {highlightViews.length > 0 && (
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
              aria-hidden
            >
              {highlightViews.map((hv) => (
                <path
                  key={hv.id}
                  d={hv.pathD}
                  fill="none"
                  stroke={hv.color}
                  strokeWidth={highlightStrokeWidth(hv.width, hv.height)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={1}
                  strokeDasharray={1}
                  strokeDashoffset={1 - hv.strokeProgress}
                  opacity={hv.opacity}
                />
              ))}
            </svg>
          )}
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted text-sm text-muted-foreground">
          No recording
        </div>
      )}
    </div>
  );

  if (contentOnly) {
    return <div className="relative h-full w-full overflow-hidden">{card}</div>;
  }

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
      {card}
    </div>
  );
}

function TemplateSceneStage({
  scene,
  progress,
  elapsedSpeechMs,
  background,
  contentOnly = false,
}: {
  scene: Scene;
  progress: number;
  elapsedSpeechMs?: number;
  background: SceneBackground;
  contentOnly?: boolean;
}) {
  const customBg = background.kind !== "whiteboard";
  const videoBg = background.kind === "video" ? background.url : null;
  const padPct = customBg ? CARD_PADDING_FRAC * 100 : 0;

  const card = (
      <div
        className="absolute overflow-hidden"
        style={{
          inset: customBg ? `${padPct}%` : 0,
          borderRadius: customBg ? "1.25rem" : 0,
          background: customBg ? "#ffffff" : "transparent",
          boxShadow: customBg ? "0 10px 40px -12px rgba(0,0,0,0.25)" : "none",
        }}
      >
        <TemplateScene scene={scene} progress={progress} elapsedMs={elapsedSpeechMs} />
      </div>
  );

  if (contentOnly) {
    return <div className="relative h-full w-full overflow-hidden">{card}</div>;
  }

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
          loop
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {card}
    </div>
  );
}

function SceneStage({
  scene,
  progress,
  elapsedSpeechMs,
  videoRef,
  background,
  transparentMap,
  playing,
  questionPhase = "question",
  markHoldElapsedMs = 0,
  contentOnly = false,
}: {
  scene: Scene;
  progress: number;
  elapsedSpeechMs: number;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  background: SceneBackground;
  transparentMap: Map<string, string>;
  playing: boolean;
  questionPhase?: QuestionDisplayPhase;
  markHoldElapsedMs?: number;
  contentOnly?: boolean;
}) {
  if (scene.kind === "question") {
    return (
      <QuestionSceneStage
        scene={scene}
        progress={progress}
        background={background}
        questionPhase={questionPhase}
        markHoldElapsedMs={markHoldElapsedMs}
        contentOnly={contentOnly}
      />
    );
  }
  if (scene.kind === "code") {
    return (
      <CodeSceneStage
        scene={scene}
        progress={progress}
        background={background}
        playing={playing}
        contentOnly={contentOnly}
      />
    );
  }
  if (scene.kind === "recording") {
    return (
      <RecordingSceneStage
        scene={scene}
        elapsedSpeechMs={elapsedSpeechMs}
        background={background}
        contentOnly={contentOnly}
        playing={playing}
      />
    );
  }
  if (scene.kind === "template") {
    return (
      <TemplateSceneStage
        scene={scene}
        progress={progress}
        elapsedSpeechMs={elapsedSpeechMs}
        background={background}
        contentOnly={contentOnly}
      />
    );
  }
  if (scene.kind === "image") {
    return (
      <ImageScene
        scene={scene}
        progress={progress}
        elapsedSpeechMs={elapsedSpeechMs}
        background={background}
        transparentMap={transparentMap}
        contentOnly={contentOnly}
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

// Slide duration comes from scene.transitionMs (probed from bundled whoosh SFX).

export function VideoPlayer({
  scenes,
  background = DEFAULT_BACKGROUND,
  bgm,
  projectId,
  onPlaybackUpdate,
}: {
  scenes: Scene[];
  background?: SceneBackground;
  /** Continuous background music for stitched part preview / export. */
  bgm?: PartBgmConfig | null;
  /** Used to persist temp stitch audio to disk before export (avoids Chrome OOM). */
  projectId?: string | null;
  onPlaybackUpdate?: (info: {
    sceneIndex: number;
    progress: number;
    elapsedSpeechMs: number;
  }) => void;
}) {

  const masterAudioUrl = scenes[0]?.masterAudioUrl;
  const masterMode = !!masterAudioUrl;
  const bgmConfig = useMemo(
    () => resolvePartBgm(bgm),
    [bgm?.url, bgm?.volume, bgm?.enabled],
  );
  const bgmMuteRanges = useMemo(() => bgmMuteRangesMs(scenes), [scenes]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsedSpeechMs, setElapsedSpeechMs] = useState(0);
  const [visualState, setVisualState] = useState<MasterVisualState | null>(null);
  const [masterCurMs, setMasterCurMs] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const markAudioRef = useRef<HTMLAudioElement>(null);
  const introAudioRef = useRef<HTMLAudioElement>(null);
  const markAudioPlayedRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [exportStarting, setExportStarting] = useState<ExportQuality | null>(null);
  const [exportRunner, setExportRunner] = useState<"server" | "agent">(() => {
    try {
      const v = localStorage.getItem("explainer.exportRunner");
      return v === "agent" ? "agent" : "server";
    } catch {
      return "server";
    }
  });
  const [transparentMap, setTransparentMap] = useState<Map<string, string>>(new Map());
  const navigate = useNavigate();

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

  // Master-mode visual state (speech / hold / slide-left transition).
  function syncBgmPosition(curMs: number, durationMs: number) {
    const el = bgmRef.current;
    if (!el || !bgmConfig) return;
    el.volume = partBgmVolumeAtMs(bgmConfig, curMs, bgmMuteRanges);
    const endMs = Math.max(0, durationMs);
    if (curMs >= endMs - 20) {
      el.pause();
      return;
    }
    const tSec = Math.min(curMs / 1000, endMs / 1000);
    if (Math.abs(el.currentTime - tSec) > 0.15) {
      el.currentTime = tSec;
    }
  }

  function syncMasterVisual(curMs: number) {
    const vis = masterVisualAt(curMs, scenes);
    if (!vis) return;
    setMasterCurMs(curMs);
    setVisualState(vis);
    setIndex(vis.sceneIndex);
    setProgress(vis.progress);
    setElapsedSpeechMs(vis.elapsedSpeechMs);
  }

  // Per-scene mode: slide-left between scenes after a short hold.
  const [perSceneTransition, setPerSceneTransition] = useState<{
    from: number;
    to: number;
    t: number;
  } | null>(null);
  /** Last-scene question: show mark screen after narration before stopping. */
  const [tailMarkHold, setTailMarkHold] = useState<{ startedAt: number } | null>(null);
  const [markHoldElapsedMs, setMarkHoldElapsedMs] = useState(0);
  const [questionSeqMs, setQuestionSeqMs] = useState(0);
  const [questionMainReady, setQuestionMainReady] = useState(true);
  const questionSeqStartRef = useRef<number>(0);
  const markHoldStartRef = useRef<number>(0);
  const perSceneHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const perSceneTransRef = useRef<number | null>(null);

  function clearPerSceneTransitionTimers() {
    if (perSceneHoldRef.current) clearTimeout(perSceneHoldRef.current);
    if (perSceneTransRef.current != null) cancelAnimationFrame(perSceneTransRef.current);
    perSceneHoldRef.current = null;
    perSceneTransRef.current = null;
  }

  function clearMarkHold() {
    setTailMarkHold(null);
    setMarkHoldElapsedMs(0);
    markHoldStartRef.current = 0;
    markAudioPlayedRef.current = false;
    markAudioRef.current?.pause();
  }

  function questionNeedsIntroGate(s: Scene | undefined): boolean {
    return !masterMode && s?.kind === "question" && !!s.questionIntroAudioUrl;
  }

  function resetQuestionIntroPlayback(sceneIdx = index) {
    const s = scenes[sceneIdx];
    setQuestionMainReady(!questionNeedsIntroGate(s));
    setQuestionSeqMs(0);
    introAudioRef.current?.pause();
    if (questionNeedsIntroGate(s)) {
      audioRef.current?.pause();
    }
  }

  useEffect(() => {
    if (masterMode || !playing || scenes[index]?.kind !== "question") {
      return;
    }
    questionSeqStartRef.current = performance.now();
    setQuestionSeqMs(0);
    let raf = 0;
    const tick = () => {
      setQuestionSeqMs(performance.now() - questionSeqStartRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, index, masterMode, scenes]);

  useEffect(() => {
    const s = scenes[index];
    if (masterMode || s?.kind !== "question" || !s.questionIntroAudioUrl) {
      setQuestionMainReady(true);
      return;
    }
    resetQuestionIntroPlayback(index);
  }, [index, masterMode, scenes]);

  useEffect(() => {
    if (masterMode || !playing || questionMainReady) return;
    const s = scenes[index];
    if (s?.kind !== "question" || !s.questionIntroAudioUrl) return;

    let gapTimer: ReturnType<typeof setTimeout> | null = null;
    const intro = introAudioRef.current;
    if (!intro) return;

    audioRef.current?.pause();
    intro.src = s.questionIntroAudioUrl;
    intro.currentTime = 0;
    void intro.play().catch(() => {});

    const onIntroEnd = () => {
      gapTimer = setTimeout(() => setQuestionMainReady(true), localIntroGapMs(s));
    };
    intro.addEventListener("ended", onIntroEnd);
    intro.addEventListener("error", onIntroEnd);
    return () => {
      intro.removeEventListener("ended", onIntroEnd);
      intro.removeEventListener("error", onIntroEnd);
      if (gapTimer) clearTimeout(gapTimer);
      intro.pause();
    };
  }, [playing, index, masterMode, questionMainReady, scenes]);

  useEffect(() => {
    if (masterMode || !playing || !questionMainReady) return;
    const s = scenes[index];
    if (s?.kind !== "question" || !s.questionIntroAudioUrl) return;
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = (scenes[index]?.audioClipStartMs ?? 0) / 1000;
    void a.play().catch(() => {});
  }, [questionMainReady, playing, masterMode, index, scenes]);

  function localIntroGapMs(s: Scene): number {
    return questionIntroGapMs(s);
  }

  function runPerSceneTransition(from: number, to: number) {
    clearPerSceneTransitionTimers();
    const holdMs = sceneHoldMs(scenes[from] ?? {});
    const transitionMs = sceneTransitionMs(scenes[from] ?? {});
    markHoldStartRef.current = performance.now();
    setMarkHoldElapsedMs(0);
    setPerSceneTransition({ from, to, t: 0 });
    perSceneHoldRef.current = setTimeout(() => {
      markAudioRef.current?.pause();
      markAudioPlayedRef.current = false;
      const transStart = performance.now();
      const tick = () => {
        const t = Math.min(1, (performance.now() - transStart) / transitionMs);
        setPerSceneTransition({ from, to, t });
        if (t < 1) {
          perSceneTransRef.current = requestAnimationFrame(tick);
        } else {
          setPerSceneTransition(null);
          clearMarkHold();
          setIndex(to);
          setProgress(0);
          setElapsedSpeechMs(0);
          perSceneTransRef.current = null;
          audioRef.current?.play().catch(() => {});
        }
      };
      perSceneTransRef.current = requestAnimationFrame(tick);
    }, holdMs);
  }
  const windows = useMemo(() => {
    if (!masterMode) return [] as { startMs: number; endMs: number }[];
    return scenes.map((s, i) => ({
      startMs: s.startMs ?? 0,
      endMs: s.endMs ?? (s.startMs ?? 0) + (s.durationMs || 4000),
    }));
  }, [scenes, masterMode]);

  const scene = scenes[index];

  async function handleExport(quality: ExportQuality) {
    if (exportStarting) return;
    setExportStarting(quality);
    try {
      const label = quality === "hd" ? "1080p30" : "720p30";
      const { jobId, runner } = await startNativeExportJob({
        scenes,
        masterAudioUrl,
        quality,
        background,
        bgm: bgm ?? undefined,
        projectId,
        filename: `explainer-${label}-${Date.now()}.mp4`,
        runner: exportRunner,
      });
      void navigate({ to: "/export", search: { jobId, runner } });

    } catch (e) {
      console.error("Export failed", e);
      alert("Export failed: " + (e as Error).message);
    } finally {
      setExportStarting(null);
    }
  }

  useEffect(() => () => {
    clearPerSceneTransitionTimers();
  }, []);

  useEffect(() => {
    const current =
      masterMode && visualState ? scenes[visualState.sceneIndex] : scenes[index];
    if (!current || current.kind !== "question") {
      markAudioPlayedRef.current = false;
      markAudioRef.current?.pause();
      return;
    }

    // Stop mark VO once the slide to the next scene begins.
    if (perSceneTransition != null && perSceneTransition.t > 0) {
      markAudioRef.current?.pause();
      return;
    }
    if (masterMode && visualState?.phase === "transition") {
      markAudioRef.current?.pause();
      return;
    }

    let postElapsed = 0;
    if (tailMarkHold != null) {
      postElapsed = markHoldElapsedMs;
    } else if (
      perSceneTransition != null &&
      perSceneTransition.t === 0 &&
      scenes[perSceneTransition.from]?.kind === "question"
    ) {
      postElapsed = markHoldElapsedMs;
    } else if (masterMode && visualState?.phase === "hold") {
      postElapsed = Math.max(
        0,
        masterCurMs -
          (current.startMs ?? 0) -
          questionPreQuestionMs(current) -
          revealSpeechDurationMs(current),
      );
    } else {
      markAudioPlayedRef.current = false;
      return;
    }

    const phase = questionPostSpeechAt(postElapsed, current).phase;
    if (!playing) {
      markAudioRef.current?.pause();
      return;
    }
    if (phase === "gap") {
      markAudioPlayedRef.current = false;
      markAudioRef.current?.pause();
      return;
    }
    if (phase !== "countdown") {
      // post-hold / done — let finishing VO play out; don't restart.
      return;
    }

    const url = current.questionMarkAudioUrl;
    if (!url || markAudioPlayedRef.current) return;
    markAudioPlayedRef.current = true;
    const el = markAudioRef.current;
    if (!el) return;
    el.src = url;
    el.play().catch(() => {});
  }, [
    playing,
    tailMarkHold,
    markHoldElapsedMs,
    perSceneTransition,
    masterMode,
    visualState,
    index,
    scenes,
    masterCurMs,
  ]);

  // Play/pause — keep question narration paused until intro + gap finish.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const s = scenes[index];
    const waitForIntro = questionNeedsIntroGate(s) && !questionMainReady;

    if (playing && !waitForIntro) {
      if (s?.kind !== "recording") {
        a.play().catch(() => {});
      }
      videoRef.current?.play().catch(() => {});
    } else {
      if (waitForIntro) a.pause();
      if (!playing) {
        a.pause();
        videoRef.current?.pause();
        introAudioRef.current?.pause();
      }
    }
  }, [playing, index, questionMainReady, masterMode, scenes]);

  // Reset stock video on scene change
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      if (playing) videoRef.current.play().catch(() => {});
    }
  }, [index]);

  // Notify parent of playback position (for debug panel).
  useEffect(() => {
    onPlaybackUpdate?.({ sceneIndex: index, progress, elapsedSpeechMs });
  }, [index, progress, elapsedSpeechMs, onPlaybackUpdate]);

  // ============ MASTER MODE: one continuous audio, timestamp-driven ============
  useEffect(() => {
    if (!masterMode) return;
    const a = audioRef.current;
    if (!a) return;

    const onTime = () => {
      syncMasterVisual(a.currentTime * 1000);
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(1);
      bgmRef.current?.pause();
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);

    let raf = 0;
    const tick = () => {
      if (a && !a.paused) {
        syncMasterVisual(a.currentTime * 1000);
      }
      raf = requestAnimationFrame(tick);
    };
    if (playing) {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnd);
      cancelAnimationFrame(raf);
    };
  }, [masterMode, playing, scenes]);

  // ============ PER-SCENE MODE (no master): reload audio per scene ============
  const clipStartMs = scenes[index]?.audioClipStartMs ?? 0;
  const recordingClockRef = useRef({ wall: 0, ms: 0 });

  useEffect(() => {
    if (masterMode) return;
    setProgress(0);
    setElapsedSpeechMs(0);
    recordingClockRef.current = { wall: performance.now(), ms: 0 };
    const a = audioRef.current;
    if (!a) return;
    const s = scenes[index];
    if (s?.kind === "recording") {
      a.pause();
      return;
    }
    a.currentTime = clipStartMs / 1000;
    const waitForIntro = questionNeedsIntroGate(s) && !questionMainReady;
    if (playing && !waitForIntro) a.play().catch(() => {});
    else a.pause();
  }, [index, masterMode, playing, clipStartMs, questionMainReady, scenes]);

  // Recording scenes: let narration <audio> play natively and drive the clock from
  // it (avoids per-frame currentTime seeks that make voice flutter in preview).
  useEffect(() => {
    if (masterMode || !playing) return;
    const s = scenes[index];
    if (s?.kind !== "recording") return;

    const sceneMs = Math.max(1, revealSpeechDurationMs(s));
    const a = audioRef.current;
    const startClock = Math.min(sceneMs, Math.max(0, recordingClockRef.current.ms));
    recordingClockRef.current = { wall: performance.now(), ms: startClock };

    if (a) {
      const startSrc = recordingAudioSourceTimeSec(s, startClock);
      try {
        a.playbackRate = recordingAudioRateAtClock(s, startClock);
      } catch {
        /* ignore */
      }
      if (startSrc == null) {
        a.pause();
      } else {
        try {
          if (Math.abs(a.currentTime - startSrc) > 0.08) a.currentTime = startSrc;
        } catch {
          /* ignore */
        }
        void a.play().catch(() => {});
      }
    }

    let raf = 0;
    const finish = () => {
      setProgress(1);
      setElapsedSpeechMs(sceneMs);
      audioRef.current?.pause();
      if (index < scenes.length - 1) runPerSceneTransition(index, index + 1);
      else setPlaying(false);
    };

    const tick = () => {
      const audio = audioRef.current;
      let clock: number;

      if (audio && !audio.paused && !audio.ended) {
        try {
          const wantRate = recordingAudioRateAtClock(s, recordingClockRef.current.ms);
          if (Math.abs(audio.playbackRate - wantRate) > 0.01) {
            audio.playbackRate = wantRate;
          }
        } catch {
          /* ignore */
        }
        const fromAudio = recordingClockMsFromAudioSourceSec(s, audio.currentTime);
        if (fromAudio != null) {
          clock = Math.min(sceneMs, fromAudio);
          recordingClockRef.current = { wall: performance.now(), ms: clock };
        } else {
          clock = Math.min(
            sceneMs,
            recordingClockRef.current.ms +
              (performance.now() - recordingClockRef.current.wall),
          );
          recordingClockRef.current = { wall: performance.now(), ms: clock };
          const nextSrc = recordingAudioSourceTimeSec(s, clock);
          if (nextSrc != null) {
            try {
              if (Math.abs(audio.currentTime - nextSrc) > 0.12) audio.currentTime = nextSrc;
            } catch {
              /* ignore */
            }
            void audio.play().catch(() => {});
          }
        }
      } else {
        clock = Math.min(
          sceneMs,
          recordingClockRef.current.ms +
            (performance.now() - recordingClockRef.current.wall),
        );
        recordingClockRef.current = { wall: performance.now(), ms: clock };
        if (audio) {
          const nextSrc = recordingAudioSourceTimeSec(s, clock);
          if (nextSrc != null) {
            try {
              if (Math.abs(audio.currentTime - nextSrc) > 0.12) audio.currentTime = nextSrc;
            } catch {
              /* ignore */
            }
            void audio.play().catch(() => {});
          }
        }
      }

      setElapsedSpeechMs(clock);
      setProgress(Math.min(1, clock / sceneMs));

      if (clock >= sceneMs - 40) {
        finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [playing, index, masterMode, scenes]);

  useEffect(() => {
    if (masterMode) return;
    if (scenes[index]?.kind === "recording") return;
    if (!questionMainReady) return;
    const a = audioRef.current;
    if (!a) return;
    let advanced = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let sawPlaying = false;

    const advance = () => {
      if (advanced) return;
      advanced = true;
      if (watchdog) clearTimeout(watchdog);
      const current = scenes[index];
      a.pause();
      setProgress(1);
      if (index < scenes.length - 1) {
        runPerSceneTransition(index, index + 1);
      } else if (current?.kind === "question" && questionPostSpeechVisualMs(current) > 0) {
        markHoldStartRef.current = performance.now();
        setMarkHoldElapsedMs(0);
        setTailMarkHold({ startedAt: markHoldStartRef.current });
      } else {
        setPlaying(false);
      }
    };
    const onTime = () => {
      const speechDurMs = revealSpeechDurationMs(scenes[index] ?? {});
      const elapsed = a.currentTime * 1000 - clipStartMs;
      const audioNaturalMs =
        a.duration && isFinite(a.duration)
          ? Math.round(a.duration * 1000) - clipStartMs
          : 0;
      const playThroughMs = Math.max(speechDurMs, audioNaturalMs);
      const clamped = Math.min(Math.max(0, elapsed), playThroughMs);
      setElapsedSpeechMs(clamped);
      const durSec = playThroughMs / 1000;
      if (durSec > 0) {
        setProgress(Math.min(1, clamped / (durSec * 1000)));
      } else if (a.duration && isFinite(a.duration)) {
        setProgress(Math.min(1, a.currentTime / a.duration));
      }
      if (clamped >= playThroughMs - 40) {
        a.pause();
        advance();
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
  }, [masterMode, index, scenes.length, clipStartMs, questionMainReady]);

  // Tick mark-your-answers hold (countdown) after question narration ends.
  useEffect(() => {
    const fromIdx = tailMarkHold ? index : perSceneTransition?.from;
    const inMarkHold =
      playing &&
      (tailMarkHold != null ||
        (perSceneTransition != null &&
          perSceneTransition.t === 0 &&
          scenes[perSceneTransition.from]?.kind === "question"));

    if (!inMarkHold || fromIdx == null) return;

    const holdMs = questionPostSpeechVisualMs(scenes[fromIdx] ?? {});
    let raf = 0;

    const tick = () => {
      const elapsed = performance.now() - markHoldStartRef.current;
      setMarkHoldElapsedMs(elapsed);
      if (elapsed >= holdMs) {
        if (tailMarkHold) {
          setTailMarkHold(null);
          setMarkHoldElapsedMs(0);
          setPlaying(false);
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, tailMarkHold, perSceneTransition, index, scenes]);

  function seekToScene(i: number) {
    clearPerSceneTransitionTimers();
    clearMarkHold();
    setPerSceneTransition(null);
    setIndex(i);
    setPlaying(true);
    if (masterMode && audioRef.current) {
      audioRef.current.currentTime = (windows[i]?.startMs ?? 0) / 1000;
      syncMasterVisual(windows[i]?.startMs ?? 0);
    }
  }

  function restart() {
    clearPerSceneTransitionTimers();
    clearMarkHold();
    setPerSceneTransition(null);
    setIndex(0);
    setProgress(0);
    setVisualState(null);
    setMasterCurMs(0);
    resetQuestionIntroPlayback(0);
    if (masterMode && audioRef.current) {
      audioRef.current.currentTime = 0;
      syncMasterVisual(0);
    }
    if (bgmRef.current) {
      bgmRef.current.currentTime = 0;
    }
    setPlaying(true);
  }

  // Master-mode continuous timeline math.
  const totalMs = masterMode
    ? windows[windows.length - 1]?.endMs ?? 1
    : scenes.reduce((a, s, i) => {
        const d = s.durationMs || 0;
        const pre = s.kind === "question" ? questionPreQuestionMs(s) : 0;
        const tail = i < scenes.length - 1 ? sceneGapMs(s) : questionPostSpeechVisualMs(s);
        return a + pre + d + tail;
      }, 0) || 1;
  const currentMs = masterMode
    ? masterCurMs
    : (() => {
        let acc = 0;
        for (let i = 0; i < index; i++) {
          acc += scenes[i]?.durationMs || 0;
          acc += sceneGapMs(scenes[i] ?? {});
        }
        const dur = scenes[index]?.durationMs || 0;
        const inMarkHold =
          tailMarkHold != null ||
          (perSceneTransition != null &&
            perSceneTransition.t === 0 &&
            scenes[perSceneTransition.from]?.kind === "question");
        if (inMarkHold) acc += dur + markHoldElapsedMs;
        else acc += progress * dur;
        return acc;
      })();
  const overallPct = Math.max(0, Math.min(100, (currentMs / totalMs) * 100));

  // Continuous background music — synced to timeline, trimmed at part end.
  // Muted over intro/outro bumpers (they already include music).
  useEffect(() => {
    const el = bgmRef.current;
    if (!el || !bgmConfig) return;
    el.volume = partBgmVolumeAtMs(bgmConfig, currentMs, bgmMuteRanges);
    if (!playing) {
      el.pause();
      return;
    }
    syncBgmPosition(currentMs, totalMs);
    if (currentMs < totalMs - 20) {
      void el.play().catch(() => {});
    }
  }, [playing, currentMs, totalMs, bgmConfig, bgmMuteRanges]);

  function seekToMs(ms: number) {
    if (masterMode && audioRef.current) {
      const clamped = Math.max(0, Math.min(totalMs - 10, ms));
      audioRef.current.currentTime = clamped / 1000;
      syncMasterVisual(clamped);
      syncBgmPosition(clamped, totalMs);
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

  const slide =
    masterMode && visualState?.phase === "transition"
      ? {
          from: visualState.fromIndex,
          to: visualState.toIndex,
          t: slideOffset(visualState.slideT),
        }
      : perSceneTransition
        ? {
            from: perSceneTransition.from,
            to: perSceneTransition.to,
            t: slideOffset(perSceneTransition.t),
          }
        : null;

  const displayScene = masterMode && visualState ? scenes[visualState.sceneIndex] : scene;
  const displayProgress =
    masterMode && visualState ? visualState.progress : perSceneTransition ? 1 : progress;
  const displayElapsedSpeechMs =
    masterMode && visualState
      ? visualState.elapsedSpeechMs
      : perSceneTransition
        ? revealSpeechDurationMs(scenes[perSceneTransition.from] ?? {})
        : elapsedSpeechMs;

  const displaySceneElapsedMs =
    displayScene?.kind === "question"
      ? masterMode && visualState
        ? Math.max(0, masterCurMs - (scenes[visualState.sceneIndex]?.startMs ?? 0))
        : tailMarkHold != null ||
            (perSceneTransition != null &&
              perSceneTransition.t === 0 &&
              scenes[perSceneTransition.from]?.kind === "question")
          ? questionPreQuestionMs(displayScene ?? {}) +
            revealSpeechDurationMs(displayScene ?? {}) +
            markHoldElapsedMs
          : !masterMode
            ? questionSeqMs
            : 0
      : 0;

  const displaySpeechDur = revealSpeechDurationMs(displayScene ?? {});
  const questionTimeline =
    displayScene?.kind === "question"
      ? questionTimelineAt(displaySceneElapsedMs, displayScene ?? {}, displaySpeechDur)
      : null;

  const displayQuestionPhase: QuestionDisplayPhase =
    questionTimeline?.phase ?? "question";
  const displayMarkCountdownElapsedMs = questionTimeline?.markElapsedMs ?? 0;
  const displayProgressResolved =
    questionTimeline != null ? questionTimeline.questionProgress : displayProgress;

  return (
    <div className="w-full">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border bg-white shadow-sm">
        {slide ? (
          <>
            <SceneBackgroundLayer background={background} />
            <div
              className="absolute inset-0"
              style={{ transform: `translateX(${-slide.t * 100}%)` }}
            >
              <SceneStage
                scene={scenes[slide.from]!}
                progress={1}
                elapsedSpeechMs={revealSpeechDurationMs(scenes[slide.from] ?? {})}
                background={background}
                transparentMap={transparentMap}
                playing={playing}
                questionPhase={
                  scenes[slide.from]?.kind === "question" ? "mark" : "question"
                }
                markHoldElapsedMs={
                  scenes[slide.from]?.kind === "question"
                    ? questionMarkCountdownMs(scenes[slide.from]!)
                    : 0
                }
                contentOnly
              />
            </div>
            <div
              className="absolute inset-0"
              style={{ transform: `translateX(${(1 - slide.t) * 100}%)` }}
            >
              <SceneStage
                scene={scenes[slide.to]!}
                progress={0}
                elapsedSpeechMs={0}
                background={background}
                transparentMap={transparentMap}
                playing={playing}
                contentOnly
              />
            </div>
          </>
        ) : (
          <div className="absolute inset-0">
            <SceneStage
              scene={displayScene ?? scene}
              progress={displayProgressResolved}
              elapsedSpeechMs={displayElapsedSpeechMs}
              videoRef={videoRef}
              background={background}
              transparentMap={transparentMap}
              playing={playing}
              questionPhase={displayQuestionPhase}
              markHoldElapsedMs={displayMarkCountdownElapsedMs}
            />
          </div>
        )}


        <audio ref={audioRef} src={audioSrc} preload="auto" />
        {bgmConfig && (
          <audio ref={bgmRef} src={bgmConfig.url} preload="auto" className="hidden" />
        )}
        <audio ref={markAudioRef} preload="auto" className="hidden" />
        <audio ref={introAudioRef} preload="auto" className="hidden" />
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
        <span className="mr-1 text-xs font-medium text-muted-foreground">Export:</span>
        <select
          value={exportRunner}
          onChange={(e) => {
            const next = e.target.value === "agent" ? "agent" : "server";
            setExportRunner(next);
            try {
              localStorage.setItem("explainer.exportRunner", next);
            } catch {
              /* ignore */
            }
          }}
          className="h-8 rounded-md border bg-background px-2 text-xs"
          title="Where to encode the MP4"
        >
          <option value="server">Studio Mac</option>
          <option value="agent">This Mac · Render Agent</option>
        </select>
        <button
          onClick={() => handleExport("preview")}
          disabled={!!exportStarting}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {exportStarting === "preview" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Download size={12} />
          )}
          720p 30fps
        </button>
        <button
          onClick={() => handleExport("hd")}
          disabled={!!exportStarting}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {exportStarting === "hd" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Download size={12} />
          )}
          HD 1080p 30fps
        </button>
        <span className="text-[11px] text-muted-foreground">
          Opens the Export page for progress
        </span>
      </div>
    </div>
  );
}
