import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Scissors, Focus, ZoomIn, ZoomOut, Trash2, Undo2, SquareDashedMousePointer } from "lucide-react";
import type {
  ComposeRecordingDraft,
  RecordingAudioSegment,
  RecordingVideoSegment,
} from "@/lib/compose-scene";
import {
  clampPlaybackRate,
  DEFAULT_PLAYBACK_RATE,
  legacyVideoFieldsFromSegments,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  normalizeRecordingAudioSegments,
  normalizeRecordingVideoSegments,
  recordingSceneDurationMs,
  recordingSegmentDurationMs,
  singleRecordingVideoSegment,
  splitRecordingAudioAtClock,
  splitRecordingVideoAtClock,
} from "@/lib/compose-scene";
import {
  recordingAudioRateAtClock,
  recordingAudioSourceTimeSec,
} from "@/lib/recording-audio-layout";
import {
  applyRecordingCameraZoomAt,
  clampCameraZoomDurationMs,
  DEFAULT_CAMERA_ZOOM_DURATION_MS,
  MAX_CAMERA_ZOOM_DURATION_MS,
  MIN_CAMERA_ZOOM_DURATION_MS,
  normalizeRecordingCameraKeyframes,
  normalizeRecordingCameraZoomSfx,
  recordingCameraAt,
  recordingCameraDrawRects,
  recordingCameraVideoLayout,
  recordingCameraZoomEvents,
  recordingCameraZoomSfxUrl,
  sourcePointToView,
  RECORDING_CAMERA_MAX_SCALE,
  RECORDING_CAMERA_MIN_SCALE,
  RECORDING_CAMERA_ZOOM_SFX_OPTIONS,
  removeRecordingCameraKeyframe,
} from "@/lib/recording-camera";
import {
  blurRadiusForStrength,
  clampBlurStrength,
  DEFAULT_BLUR_STRENGTH,
  MAX_BLUR_STRENGTH,
  MIN_BLUR_STRENGTH,
  normalizeRecordingBlurRegion,
  sourceBlurRectToView,
  viewDragToSourceBlurRegion,
  viewPointToSourceNorm,
  type RecordingBlurRegion,
} from "@/lib/recording-blur";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLOR_PRESETS,
  HIGHLIGHT_TOTAL_MS,
  handDrawnRectPathD,
  highlightAnimAtMs,
  highlightStrokeWidth,
  newRecordingHighlightId,
  normalizeHighlightColor,
  normalizeRecordingHighlight,
  normalizeRecordingHighlights,
  sourceHighlightRectToView,
  type RecordingHighlight,
} from "@/lib/recording-highlight";

interface RecordingTimelineProps {
  draft: ComposeRecordingDraft;
  onChange: (patch: Partial<ComposeRecordingDraft>) => void;
  disabled?: boolean;
  /**
   * `full` — audio/video sync + camera + blur (Screen recording).
   * `cameraBlur` — zoom + blur only (Screen recording 2).
   */
  features?: "full" | "cameraBlur";
}

type DragTarget =
  | { kind: "scrub" }
  | { kind: "video"; id: string; mode: "move" | "trim-left" | "trim-right" }
  | { kind: "audio"; id: string; mode: "move" | "trim-left" | "trim-right" }
  | { kind: "camera"; atMs: number };

const MIN_TRIM_MS = 10;
const LABEL_W = 56;
const HANDLE_W = 10;
const TRACK_H = 44;
const RULER_H = 28;
/** Keep playhead / camera KF circles fully visible at t=0 and the end. */
const TRACK_EDGE_PAD = 16;
const TIMELINE_ZOOM_MIN = 1;
const TIMELINE_ZOOM_MAX = 64;
const UNDO_STACK_MAX = 50;

type TimelineUndoSnapshot = {
  audioSegments: RecordingAudioSegment[];
  videoSegments: RecordingVideoSegment[];
  trimStartMs: number;
  trimEndMs: number;
  videoOffsetMs: number;
  cameraKeyframes: ComposeRecordingDraft["cameraKeyframes"];
  cameraZoomDurationMs: number;
  cameraZoomSfx: ComposeRecordingDraft["cameraZoomSfx"];
  blurRegion: RecordingBlurRegion | null;
  highlights: RecordingHighlight[];
};

function snapshotTimeline(d: ComposeRecordingDraft): TimelineUndoSnapshot {
  return {
    audioSegments: d.audioSegments.map((s) => ({ ...s })),
    videoSegments: normalizeRecordingVideoSegments(d).map((s) => ({ ...s })),
    trimStartMs: d.trimStartMs,
    trimEndMs: d.trimEndMs,
    videoOffsetMs: d.videoOffsetMs,
    cameraKeyframes: d.cameraKeyframes.map((k) => ({ ...k })),
    cameraZoomDurationMs: d.cameraZoomDurationMs,
    cameraZoomSfx: d.cameraZoomSfx,
    blurRegion: d.blurRegion ? { ...d.blurRegion } : null,
    highlights: normalizeRecordingHighlights(d.highlights ?? []).map((h) => ({ ...h })),
  };
}

function fmt(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (m > 0) return `${m}:${rem.toFixed(1).padStart(4, "0")}`;
  if (ms < 10_000 && ms % 1000 !== 0) return `${(ms / 1000).toFixed(3)}s`;
  return `${rem.toFixed(1)}s`;
}

function fmtClock(ms: number, fine = false): string {
  const totalMs = Math.max(0, ms);
  if (fine) {
    const m = Math.floor(totalMs / 60_000);
    const s = Math.floor((totalMs % 60_000) / 1000);
    const frac = Math.round(totalMs % 1000);
    if (m > 0) {
      return `${m}:${String(s).padStart(2, "0")}.${String(frac).padStart(3, "0")}`;
    }
    return `${s}.${String(frac).padStart(3, "0")}s`;
  }
  const total = Math.max(0, Math.round(totalMs / 100) * 100) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function niceStepMs(totalMs: number, zoom: number): number {
  const visible = totalMs / Math.max(1, zoom);
  const target = visible / 10;
  const steps = [
    1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000,
  ];
  return steps.find((s) => s >= target) ?? 60_000;
}

/** Map scene clock → active video segment's source time + rate, or nearest edge frame. */
function activeVideoWindow(
  segments: RecordingVideoSegment[],
  ms: number,
): { sourceSec: number; rate: number; inWindow: boolean } {
  for (const seg of segments) {
    const dur = recordingSegmentDurationMs(seg);
    const local = ms - seg.offsetMs;
    if (local >= 0 && local <= dur) {
      const rate = clampPlaybackRate(seg.rate);
      return { sourceSec: (seg.trimStartMs + local * rate) / 1000, rate, inWindow: true };
    }
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first && ms < first.offsetMs) {
    return { sourceSec: first.trimStartMs / 1000, rate: 1, inWindow: false };
  }
  if (last) return { sourceSec: last.trimEndMs / 1000, rate: 1, inWindow: false };
  return { sourceSec: 0, rate: 1, inWindow: false };
}

/**
 * Canva-style timeline: multi audio clips (split at playhead), video trim/move,
 * large preview, and a draggable playhead.
 */
export function RecordingTimeline({
  draft,
  onChange,
  disabled,
  features = "full",
}: RecordingTimelineProps) {
  const cameraBlurOnly = features === "cameraBlur";
  const isVideoClip =
    draft.useEmbeddedAudio === true && draft.voiceReplace !== true;
  const cameraFit = isVideoClip ? "contain" : "cover";
  const camTrackTop = cameraBlurOnly ? 0 : (TRACK_H + 6) * 2;
  const tracksHeight = cameraBlurOnly ? TRACK_H : TRACK_H * 3 + 12;
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const zoomSfxRef = useRef<HTMLAudioElement>(null);
  const lastZoomSfxStartRef = useRef<number | null>(null);
  const audioSegActiveRef = useRef<string | null>(null);
  const videoSegActiveRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const playAnchorRef = useRef({ wall: 0, ms: 0 });
  const timelineZoomRef = useRef(1);
  const undoStackRef = useRef<TimelineUndoSnapshot[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dragRef = useRef<{
    target: DragTarget;
    startX: number;
    originSegments: RecordingAudioSegment[];
    originVideoSegments: RecordingVideoSegment[];
    originCameraAtMs: number;
    originCameraKeyframe: {
      atMs: number;
      scale: number;
      focusX: number;
      focusY: number;
      easing?: "linear" | "easeInOut";
    } | null;
    undoPushed?: boolean;
  } | null>(null);

  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState<DragTarget | null>(null);
  const [viewportWidth, setViewportWidth] = useState(640);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [undoDepth, setUndoDepth] = useState(0);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [speedTrack, setSpeedTrack] = useState<"audio" | "video">("audio");
  const [selectedCameraAtMs, setSelectedCameraAtMs] = useState<number | null>(null);
  const [focusPickMode, setFocusPickMode] = useState(false);
  const [blurDrawMode, setBlurDrawMode] = useState(false);
  const [blurDrag, setBlurDrag] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const blurDragRef = useRef<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [highlightDrawMode, setHighlightDrawMode] = useState(false);
  const [highlightDrag, setHighlightDrag] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const highlightDragRef = useRef<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [highlightColor, setHighlightColor] = useState(DEFAULT_HIGHLIGHT_COLOR);
  const [previewVideoSize, setPreviewVideoSize] = useState({ w: 0, h: 0 });
  const [previewBoxSize, setPreviewBoxSize] = useState({ w: 0, h: 0 });
  const previewBoxRef = useRef<HTMLDivElement>(null);

  const source = Math.max(0, draft.sourceDurationMs);
  const audioSource = Math.max(0, draft.audioDurationMs);
  const audioSegments = normalizeRecordingAudioSegments(draft);
  const videoSegments = normalizeRecordingVideoSegments(draft);
  const cameraKeyframes = normalizeRecordingCameraKeyframes(draft.cameraKeyframes);
  const zoomDurationMs = clampCameraZoomDurationMs(
    draft.cameraZoomDurationMs ?? DEFAULT_CAMERA_ZOOM_DURATION_MS,
  );
  const zoomSfx = normalizeRecordingCameraZoomSfx(draft.cameraZoomSfx);
  const zoomSfxUrl = recordingCameraZoomSfxUrl(zoomSfx);
  const sceneMs = recordingSceneDurationMs({
    audioSegments,
    audioDurationMs: audioSource,
    videoSegments,
    trimStartMs: draft.trimStartMs,
    trimEndMs: draft.trimEndMs,
    sourceDurationMs: source,
    videoOffsetMs: draft.videoOffsetMs,
  });
  const totalMs = Math.max(sceneMs + 1500, 3000);
  const camNow = recordingCameraAt(cameraKeyframes, playheadMs);
  const blurRegion = normalizeRecordingBlurRegion(draft.blurRegion);
  const blurStrength = blurRegion?.strength ?? DEFAULT_BLUR_STRENGTH;
  const highlights = normalizeRecordingHighlights(draft.highlights ?? []);

  const previewCamera = useMemo(() => {
    const iw = previewVideoSize.w;
    const ih = previewVideoSize.h;
    const cw = previewBoxSize.w;
    const ch = previewBoxSize.h;
    if (!iw || !ih || !cw || !ch) return null;
    const rects = recordingCameraDrawRects(iw, ih, 0, 0, cw, ch, camNow, cameraFit);
    if (!rects) return null;
    return {
      rects,
      videoLayout: recordingCameraVideoLayout(iw, ih, rects, cameraFit),
      focusView: sourcePointToView(camNow.focusX, camNow.focusY, iw, ih, rects),
    };
  }, [previewVideoSize, previewBoxSize, camNow, cameraFit]);

  const timelineInnerWidth = Math.max(120, viewportWidth * timelineZoom);
  const contentWidth = timelineInnerWidth + TRACK_EDGE_PAD * 2;
  const pxPerMs = timelineInnerWidth > 0 ? timelineInnerWidth / totalMs : 0;
  const msPerPx = pxPerMs > 0 ? 1 / pxPerMs : 0;
  const fineTicks = timelineZoom >= 4;
  timelineZoomRef.current = timelineZoom;
  const timeToX = (ms: number) => TRACK_EDGE_PAD + ms * pxPerMs;

  const ticks = useMemo(() => {
    const step = niceStepMs(totalMs, timelineZoom);
    const out: number[] = [];
    for (let t = 0; t <= totalMs + 1; t += step) out.push(t);
    return out;
  }, [totalMs, timelineZoom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 40) setViewportWidth(w);
    });
    ro.observe(el);
    setViewportWidth(el.clientWidth || 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setPreviewBoxSize({ w: r.width, h: r.height });
      }
    });
    ro.observe(el);
    setPreviewBoxSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [draft.mediaUrl]);

  useEffect(() => {
    const v = previewRef.current;
    if (!v) return;
    const sync = () => {
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setPreviewVideoSize({ w: v.videoWidth, h: v.videoHeight });
      }
    };
    sync();
    v.addEventListener("loadedmetadata", sync);
    return () => v.removeEventListener("loadedmetadata", sync);
  }, [draft.mediaUrl]);

  useEffect(() => {
    undoStackRef.current = [];
    setUndoDepth(0);
  }, [draft.mediaUrl, draft.audioUrl]);

  useEffect(() => {
    setPlayheadMs((p) => clamp(p, 0, sceneMs));
  }, [sceneMs]);

  useEffect(() => {
    if (!selectedAudioId && audioSegments[0]) setSelectedAudioId(audioSegments[0].id);
  }, [audioSegments, selectedAudioId]);

  useEffect(() => {
    if (!selectedVideoId && videoSegments[0]) setSelectedVideoId(videoSegments[0].id);
  }, [videoSegments, selectedVideoId]);

  /** Seek video to scene clock. During free-run playback, only correct large drift. */
  const syncVideoToPlayhead = useCallback(
    (ms: number, mode: "scrub" | "start" | "play" = "scrub") => {
      const v = previewRef.current;
      if (!v || !draft.mediaUrl) return;
      const activeSeg =
        videoSegments.find((seg) => {
          const dur = recordingSegmentDurationMs(seg);
          const local = ms - seg.offsetMs;
          return local >= 0 && local <= dur;
        })?.id ?? null;
      const win = activeVideoWindow(videoSegments, ms);
      if (!win.inWindow) {
        if (!v.paused) v.pause();
        videoSegActiveRef.current = null;
        if (Math.abs(v.currentTime - win.sourceSec) > 0.05) {
          try {
            v.currentTime = win.sourceSec;
          } catch {
            /* ignore */
          }
        }
        return;
      }
      const enteredNewSeg =
        mode === "start" || mode === "scrub" || activeSeg !== videoSegActiveRef.current;
      videoSegActiveRef.current = activeSeg;
      const drift = Math.abs(v.currentTime - win.sourceSec);
      // Scrub / play-start / segment-enter: hard seek. While playing: let media
      // free-run (Safari glitches hard if we rewrite currentTime every frame).
      const shouldSeek =
        mode === "scrub" || mode === "start" || enteredNewSeg ? drift > 0.03 : drift > 0.45;
      if (shouldSeek) {
        try {
          v.currentTime = win.sourceSec;
        } catch {
          /* ignore */
        }
      }
      if (Math.abs(v.playbackRate - win.rate) > 0.001) {
        try {
          v.playbackRate = win.rate;
        } catch {
          /* ignore */
        }
      }
      if (mode === "start" || mode === "play") {
        if (v.paused) void v.play().catch(() => {});
      } else if (!v.paused) {
        v.pause();
      }
    },
    [draft.mediaUrl, videoSegments],
  );

  /**
   * Map scene clock → source audio. Seek only on scrub / segment enter / large drift.
   * Continuous per-frame seeks are what make Safari (and Chrome) stutter.
   */
  const syncAudioToPlayhead = useCallback(
    (ms: number, mode: "scrub" | "start" | "play" = "scrub") => {
      const a = audioRef.current;
      if (!a || !draft.audioUrl) return;
      const srcSec = recordingAudioSourceTimeSec(
        {
          recordingAudioSegments: audioSegments,
          recordingAudioSourceDurationMs: audioSource,
        },
        ms,
      );
      if (srcSec == null) {
        if (!a.paused) a.pause();
        audioSegActiveRef.current = null;
        return;
      }

      const activeSeg =
        audioSegments.find((seg) => {
          const trimmed = Math.max(0, seg.trimEndMs - seg.trimStartMs);
          const local = ms - seg.offsetMs;
          return local >= 0 && local <= trimmed;
        })?.id ?? null;
      const enteredNewSeg =
        mode === "start" ||
        mode === "scrub" ||
        (activeSeg != null && activeSeg !== audioSegActiveRef.current);
      audioSegActiveRef.current = activeSeg;

      const rate = recordingAudioRateAtClock(
        {
          recordingAudioSegments: audioSegments,
          recordingAudioSourceDurationMs: audioSource,
        },
        ms,
      );
      if (Math.abs(a.playbackRate - rate) > 0.001) {
        try {
          a.playbackRate = rate;
        } catch {
          /* ignore */
        }
      }

      const drift = Math.abs(a.currentTime - srcSec);
      const shouldSeek =
        mode === "scrub" || mode === "start" || enteredNewSeg
          ? drift > 0.03
          : drift > 0.5;
      if (shouldSeek) {
        try {
          a.currentTime = srcSec;
        } catch {
          /* ignore */
        }
      }
      if (mode === "start" || mode === "play") {
        if (a.paused) void a.play().catch(() => {});
      } else if (!a.paused) {
        a.pause();
      }
    },
    [audioSegments, audioSource, draft.audioUrl],
  );

  const stopPlayback = useCallback(() => {
    setPlaying(false);
    audioRef.current?.pause();
    previewRef.current?.pause();
    audioSegActiveRef.current = null;
    videoSegActiveRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const pushUndo = useCallback(() => {
    const snap = snapshotTimeline(draftRef.current);
    const stack = undoStackRef.current;
    const last = stack[stack.length - 1];
    if (
      last &&
      last.trimStartMs === snap.trimStartMs &&
      last.trimEndMs === snap.trimEndMs &&
      last.videoOffsetMs === snap.videoOffsetMs &&
      last.cameraZoomDurationMs === snap.cameraZoomDurationMs &&
      last.cameraZoomSfx === snap.cameraZoomSfx &&
      last.audioSegments.length === snap.audioSegments.length &&
      last.videoSegments.length === snap.videoSegments.length &&
      last.cameraKeyframes.length === snap.cameraKeyframes.length &&
      ((last.blurRegion == null && snap.blurRegion == null) ||
        (last.blurRegion != null &&
          snap.blurRegion != null &&
          last.blurRegion.x === snap.blurRegion.x &&
          last.blurRegion.y === snap.blurRegion.y &&
          last.blurRegion.w === snap.blurRegion.w &&
          last.blurRegion.h === snap.blurRegion.h &&
          last.blurRegion.strength === snap.blurRegion.strength)) &&
      last.highlights.length === snap.highlights.length &&
      last.highlights.every(
        (h, i) =>
          h.id === snap.highlights[i]?.id &&
          h.atMs === snap.highlights[i]?.atMs &&
          h.drawMs === snap.highlights[i]?.drawMs &&
          h.color === snap.highlights[i]?.color &&
          h.x === snap.highlights[i]?.x &&
          h.y === snap.highlights[i]?.y &&
          h.w === snap.highlights[i]?.w &&
          h.h === snap.highlights[i]?.h,
      ) &&
      last.audioSegments.every(
        (s, i) =>
          s.id === snap.audioSegments[i]?.id &&
          s.trimStartMs === snap.audioSegments[i]?.trimStartMs &&
          s.trimEndMs === snap.audioSegments[i]?.trimEndMs &&
          s.offsetMs === snap.audioSegments[i]?.offsetMs,
      ) &&
      last.videoSegments.every(
        (s, i) =>
          s.id === snap.videoSegments[i]?.id &&
          s.trimStartMs === snap.videoSegments[i]?.trimStartMs &&
          s.trimEndMs === snap.videoSegments[i]?.trimEndMs &&
          s.offsetMs === snap.videoSegments[i]?.offsetMs &&
          (s.rate ?? DEFAULT_PLAYBACK_RATE) ===
            (snap.videoSegments[i]?.rate ?? DEFAULT_PLAYBACK_RATE),
      ) &&
      last.cameraKeyframes.every(
        (k, i) =>
          k.atMs === snap.cameraKeyframes[i]?.atMs &&
          k.scale === snap.cameraKeyframes[i]?.scale &&
          k.focusX === snap.cameraKeyframes[i]?.focusX &&
          k.focusY === snap.cameraKeyframes[i]?.focusY,
      )
    ) {
      return;
    }
    undoStackRef.current = [...stack.slice(-(UNDO_STACK_MAX - 1)), snap];
    setUndoDepth(undoStackRef.current.length);
  }, []);

  const undoTimeline = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1]!;
    undoStackRef.current = stack.slice(0, -1);
    setUndoDepth(undoStackRef.current.length);
    stopPlayback();
    onChange({
      audioSegments: prev.audioSegments.map((s) => ({ ...s })),
      videoSegments: prev.videoSegments.map((s) => ({ ...s })),
      trimStartMs: prev.trimStartMs,
      trimEndMs: prev.trimEndMs,
      videoOffsetMs: prev.videoOffsetMs,
      cameraKeyframes: prev.cameraKeyframes.map((k) => ({ ...k })),
      cameraZoomDurationMs: prev.cameraZoomDurationMs,
      cameraZoomSfx: prev.cameraZoomSfx,
      blurRegion: prev.blurRegion ? { ...prev.blurRegion } : null,
      highlights: normalizeRecordingHighlights(prev.highlights).map((h) => ({ ...h })),
    });
  }, [onChange, stopPlayback]);

  useEffect(() => {
    if (playing) return;
    syncVideoToPlayhead(playheadMs, "scrub");
    syncAudioToPlayhead(playheadMs, "scrub");
  }, [playheadMs, playing, syncAudioToPlayhead, syncVideoToPlayhead]);

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const elapsed = performance.now() - playAnchorRef.current.wall;
      const nextMs = Math.min(sceneMs, playAnchorRef.current.ms + elapsed);
      setPlayheadMs(nextMs);
      // Free-run: do not hard-seek every frame — only pause/resume at gaps
      // and correct catastrophic drift.
      syncVideoToPlayhead(nextMs, "play");
      syncAudioToPlayhead(nextMs, "play");
      if (nextMs >= sceneMs - 20) {
        stopPlayback();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, sceneMs, stopPlayback, syncAudioToPlayhead, syncVideoToPlayhead]);

  useEffect(() => stopPlayback, [draft.audioUrl, stopPlayback]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!draft.audioUrl) {
      a.removeAttribute("src");
      a.load();
      return;
    }
    if (a.getAttribute("src") !== draft.audioUrl) {
      a.src = draft.audioUrl;
      a.load();
    }
  }, [draft.audioUrl]);

  const canPlay = !!draft.audioUrl && audioSource > 0 && !disabled;

  const seekMedia = useCallback(async (el: HTMLMediaElement, tSec: number) => {
    if (!Number.isFinite(tSec)) return;
    if (Math.abs(el.currentTime - tSec) <= 0.03) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener("seeked", finish);
        resolve();
      };
      el.addEventListener("seeked", finish);
      try {
        el.currentTime = tSec;
      } catch {
        finish();
        return;
      }
      window.setTimeout(finish, 350);
    });
  }, []);

  const togglePlay = useCallback(() => {
    if (!canPlay) return;
    if (playing) {
      stopPlayback();
      return;
    }
    let startMs = playheadMs;
    if (startMs >= sceneMs - 50) startMs = 0;
    playAnchorRef.current = { wall: performance.now(), ms: startMs };
    setPlayheadMs(startMs);

    const a = audioRef.current;
    const v = previewRef.current;
    const srcSec = recordingAudioSourceTimeSec(
      {
        recordingAudioSegments: audioSegments,
        recordingAudioSourceDurationMs: audioSource,
      },
      startMs,
    );

    void (async () => {
      // Wait for Safari seeks to finish before free-running — otherwise it
      // starts from the wrong offset and "glitches" for the first second.
      if (v && draft.mediaUrl) {
        const win = activeVideoWindow(videoSegments, startMs);
        await seekMedia(v, win.sourceSec);
        v.playbackRate = win.rate;
        if (win.inWindow) void v.play().catch(() => {});
        else v.pause();
      }
      if (a && srcSec != null) {
        audioSegActiveRef.current =
          audioSegments.find((seg) => {
            const trimmed = Math.max(0, seg.trimEndMs - seg.trimStartMs);
            const local = startMs - seg.offsetMs;
            return local >= 0 && local <= trimmed;
          })?.id ?? null;
        await seekMedia(a, srcSec);
        void a.play().catch(() => {});
      } else {
        a?.pause();
        audioSegActiveRef.current = null;
      }
      playAnchorRef.current = { wall: performance.now(), ms: startMs };
      setPlaying(true);
    })();
  }, [
    audioSegments,
    audioSource,
    canPlay,
    draft.mediaUrl,
    playheadMs,
    playing,
    sceneMs,
    seekMedia,
    stopPlayback,
    videoSegments,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        if (typing) return;
        e.preventDefault();
        undoTimeline();
        return;
      }

      if (e.code !== "Space" && e.key !== " ") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typing) return;
      if (!canPlay) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canPlay, togglePlay, undoTimeline]);

  const restartPlayback = useCallback(() => {
    stopPlayback();
    setPlayheadMs(0);
    syncVideoToPlayhead(0, "scrub");
    syncAudioToPlayhead(0, "scrub");
  }, [stopPlayback, syncAudioToPlayhead, syncVideoToPlayhead]);

  const clientXToMs = useCallback(
    (clientX: number) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return 0;
      const rect = scrollEl.getBoundingClientRect();
      const x = clamp(
        clientX - rect.left + scrollEl.scrollLeft - TRACK_EDGE_PAD,
        0,
        timelineInnerWidth,
      );
      return x * msPerPx;
    },
    [timelineInnerWidth, msPerPx],
  );

  const applyTimelineZoom = useCallback(
    (nextZoom: number, anchorClientX?: number) => {
      const scrollEl = scrollRef.current;
      const clamped = clamp(
        Number(nextZoom.toFixed(3)),
        TIMELINE_ZOOM_MIN,
        TIMELINE_ZOOM_MAX,
      );
      const prev = timelineZoomRef.current;
      if (Math.abs(clamped - prev) < 0.001) return;

      let anchorMs = playheadMs;
      let anchorOffsetInView = 0;
      if (scrollEl) {
        const rect = scrollEl.getBoundingClientRect();
        const cursorX =
          anchorClientX != null
            ? clamp(anchorClientX - rect.left, 0, rect.width)
            : rect.width / 2;
        anchorOffsetInView = cursorX;
        const oldInner = Math.max(120, viewportWidth * prev);
        const oldPxPerMs = oldInner / totalMs;
        anchorMs =
          (scrollEl.scrollLeft + cursorX - TRACK_EDGE_PAD) / Math.max(oldPxPerMs, 1e-9);
      }

      setTimelineZoom(clamped);
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        const newInner = Math.max(120, viewportWidth * clamped);
        const newPxPerMs = newInner / totalMs;
        el.scrollLeft = Math.max(
          0,
          TRACK_EDGE_PAD + anchorMs * newPxPerMs - anchorOffsetInView,
        );
      });
    },
    [playheadMs, totalMs, viewportWidth],
  );

  const onTimelineWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      applyTimelineZoom(timelineZoomRef.current * factor, e.clientX);
    },
    [applyTimelineZoom],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      applyTimelineZoom(timelineZoomRef.current * factor, e.clientX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyTimelineZoom]);

  const patchSegments = useCallback(
    (next: RecordingAudioSegment[]) => {
      onChange({ audioSegments: next });
    },
    [onChange],
  );

  const patchVideoSegments = useCallback(
    (next: RecordingVideoSegment[]) => {
      onChange(legacyVideoFieldsFromSegments(next));
    },
    [onChange],
  );

  const applyDrag = useCallback(
    (clientX: number) => {
      const drag = dragRef.current;
      if (!drag || disabled) return;
      const dx = clientX - drag.startX;
      const dMs = dx * msPerPx;
      const target = drag.target;

      if (target.kind === "scrub") {
        stopPlayback();
        setPlayheadMs(clamp(clientXToMs(clientX), 0, sceneMs));
        return;
      }

      if (target.kind === "video") {
        const segs = drag.originVideoSegments.map((s) => ({ ...s }));
        const idx = segs.findIndex((s) => s.id === target.id);
        if (idx < 0) return;
        const origin = drag.originVideoSegments[idx]!;
        const rate = clampPlaybackRate(origin.rate);

        if (target.mode === "move") {
          const maxOff = Math.max(0, totalMs - 100);
          const minOff = -Math.max(0, recordingSegmentDurationMs(origin) - MIN_TRIM_MS);
          segs[idx] = {
            ...origin,
            offsetMs: Math.round(clamp(origin.offsetMs + dMs, minOff, maxOff)),
          };
          patchVideoSegments(segs);
          return;
        }
        if (target.mode === "trim-left") {
          const maxStart = origin.trimEndMs - MIN_TRIM_MS;
          const nextStart = clamp(origin.trimStartMs + dMs * rate, 0, maxStart);
          const delta = (nextStart - origin.trimStartMs) / rate;
          segs[idx] = {
            ...origin,
            trimStartMs: Math.round(nextStart),
            offsetMs: Math.round(origin.offsetMs + delta),
          };
          patchVideoSegments(segs);
          return;
        }
        if (target.mode === "trim-right") {
          const minEnd = origin.trimStartMs + MIN_TRIM_MS;
          segs[idx] = {
            ...origin,
            trimEndMs: Math.round(clamp(origin.trimEndMs + dMs * rate, minEnd, source)),
          };
          patchVideoSegments(segs);
        }
        return;
      }

      if (target.kind === "audio") {
        const segs = drag.originSegments.map((s) => ({ ...s }));
        const idx = segs.findIndex((s) => s.id === target.id);
        if (idx < 0) return;

        if (target.mode === "move") {
          const origin = drag.originSegments[idx]!;
          const maxOff = Math.max(0, totalMs - 100);
          const minOff = -Math.max(0, recordingSegmentDurationMs(origin) - MIN_TRIM_MS);
          segs[idx] = {
            ...origin,
            offsetMs: Math.round(clamp(origin.offsetMs + dMs, minOff, maxOff)),
          };
          patchSegments(segs);
          return;
        }
        if (target.mode === "trim-left") {
          const origin = drag.originSegments[idx]!;
          const maxStart = origin.trimEndMs - MIN_TRIM_MS;
          const nextStart = clamp(origin.trimStartMs + dMs, 0, maxStart);
          const delta = nextStart - origin.trimStartMs;
          segs[idx] = {
            ...origin,
            trimStartMs: Math.round(nextStart),
            offsetMs: Math.round(origin.offsetMs + delta),
          };
          patchSegments(segs);
          return;
        }
        if (target.mode === "trim-right") {
          const origin = drag.originSegments[idx]!;
          const minEnd = origin.trimStartMs + MIN_TRIM_MS;
          segs[idx] = {
            ...origin,
            trimEndMs: Math.round(clamp(origin.trimEndMs + dMs, minEnd, audioSource)),
          };
          patchSegments(segs);
        }
        return;
      }

      if (target.kind === "camera") {
        const kf = drag.originCameraKeyframe;
        if (!kf || drag.originCameraAtMs <= 0) return;
        const nextAt = Math.round(clamp(drag.originCameraAtMs + dMs, 0, sceneMs));
        const without = cameraKeyframes.filter(
          (k) =>
            Math.abs(k.atMs - drag.originCameraAtMs) > 40 &&
            Math.abs(k.atMs - nextAt) > 40,
        );
        onChange({
          cameraKeyframes: normalizeRecordingCameraKeyframes([
            ...without,
            { ...kf, atMs: nextAt },
          ]),
        });
        setSelectedCameraAtMs(nextAt);
      }
    },
    [
      audioSource,
      cameraKeyframes,
      clientXToMs,
      disabled,
      msPerPx,
      onChange,
      patchSegments,
      patchVideoSegments,
      sceneMs,
      source,
      stopPlayback,
      totalMs,
    ],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      e.preventDefault();
      applyDrag(e.clientX);
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, applyDrag]);

  function beginDrag(target: DragTarget, e: React.PointerEvent) {
    if (disabled) return;
    if (cameraBlurOnly && (target.kind === "audio" || target.kind === "video")) return;
    stopPlayback();
    e.preventDefault();
    e.stopPropagation();
    if (target.kind !== "scrub") {
      pushUndo();
    }
    dragRef.current = {
      target,
      startX: e.clientX,
      originSegments: audioSegments.map((s) => ({ ...s })),
      originVideoSegments: videoSegments.map((s) => ({ ...s })),
      originCameraAtMs: target.kind === "camera" ? target.atMs : 0,
      originCameraKeyframe:
        target.kind === "camera"
          ? (cameraKeyframes.find((k) => Math.abs(k.atMs - target.atMs) <= 40) ?? null)
          : null,
      undoPushed: target.kind !== "scrub",
    };
    setDragging(target);
    if (target.kind === "scrub") {
      setPlayheadMs(clamp(clientXToMs(e.clientX), 0, sceneMs));
    }
    if (target.kind === "audio") {
      setSelectedAudioId(target.id);
      setSpeedTrack("audio");
    }
    if (target.kind === "video") {
      setSelectedVideoId(target.id);
      setSpeedTrack("video");
    }
    if (target.kind === "camera") setSelectedCameraAtMs(target.atMs);
  }

  function patchCamera(next: typeof cameraKeyframes) {
    onChange({ cameraKeyframes: normalizeRecordingCameraKeyframes(next) });
  }

  function playZoomSfx() {
    const url = zoomSfxUrl;
    const el = zoomSfxRef.current;
    if (!url || !el) return;
    el.src = url;
    el.currentTime = 0;
    el.volume = 0.75;
    void el.play().catch(() => {});
  }

  function handleAddCameraKeyframe(scale?: number) {
    if (disabled) return;
    pushUndo();
    // Don't overwrite the base KF at 0 — place the zoom finish after Zoom time.
    const atMs = playheadMs <= 40 ? zoomDurationMs : playheadMs;
    const next = applyRecordingCameraZoomAt(
      cameraKeyframes,
      atMs,
      {
        scale: scale ?? Math.min(RECORDING_CAMERA_MAX_SCALE, Math.max(camNow.scale, 1.5)),
        focusX: camNow.focusX,
        focusY: camNow.focusY,
      },
      zoomDurationMs,
    );
    patchCamera(next);
    setSelectedCameraAtMs(Math.round(atMs));
    setPlayheadMs(Math.round(atMs));
    playZoomSfx();
  }

  function handleResetCamera() {
    if (disabled) return;
    pushUndo();
    const next = applyRecordingCameraZoomAt(
      cameraKeyframes,
      playheadMs,
      {
        scale: 1,
        focusX: 0.5,
        focusY: 0.5,
      },
      zoomDurationMs,
    );
    patchCamera(next);
    setSelectedCameraAtMs(Math.round(playheadMs));
    playZoomSfx();
  }

  function handleDeleteCameraKeyframe() {
    if (disabled || selectedCameraAtMs == null || selectedCameraAtMs <= 0) return;
    pushUndo();
    patchCamera(removeRecordingCameraKeyframe(cameraKeyframes, selectedCameraAtMs));
    setSelectedCameraAtMs(null);
  }

  function handlePreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    if (disabled || !focusPickMode || blurDrawMode || highlightDrawMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const iw = previewVideoSize.w || previewRef.current?.videoWidth || 0;
    const ih = previewVideoSize.h || previewRef.current?.videoHeight || 0;
    const drawRects = previewCameraRects();
    const mapped =
      drawRects && iw && ih ? viewPointToSourceNorm(px, py, iw, ih, drawRects) : null;
    const fx = mapped?.x ?? clamp(px / Math.max(1, rect.width), 0, 1);
    const fy = mapped?.y ?? clamp(py / Math.max(1, rect.height), 0, 1);
    pushUndo();
    const next = applyRecordingCameraZoomAt(
      cameraKeyframes,
      playheadMs,
      {
        scale: Math.max(camNow.scale, 1.5),
        focusX: fx,
        focusY: fy,
      },
      zoomDurationMs,
    );
    patchCamera(next);
    setSelectedCameraAtMs(Math.round(playheadMs));
    setFocusPickMode(false);
    playZoomSfx();
  }

  function previewCameraRects() {
    const v = previewRef.current;
    const box = previewBoxRef.current;
    const iw = previewVideoSize.w || v?.videoWidth || 0;
    const ih = previewVideoSize.h || v?.videoHeight || 0;
    const cw = previewBoxSize.w || box?.clientWidth || 0;
    const ch = previewBoxSize.h || box?.clientHeight || 0;
    if (!iw || !ih || !cw || !ch) return null;
    return recordingCameraDrawRects(iw, ih, 0, 0, cw, ch, camNow, cameraFit);
  }

  function localPointFromEvent(e: React.PointerEvent<HTMLElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: clamp(e.clientX - rect.left, 0, rect.width),
      y: clamp(e.clientY - rect.top, 0, rect.height),
    };
  }

  function commitBlurDrag() {
    const drag = blurDragRef.current;
    blurDragRef.current = null;
    setBlurDrag(null);
    if (!drag) return;

    const minSide = Math.min(Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    if (minSide < 4) return;

    const v = previewRef.current;
    const box = previewBoxRef.current;
    const iw = previewVideoSize.w || v?.videoWidth || 0;
    const ih = previewVideoSize.h || v?.videoHeight || 0;
    const rects = previewCameraRects();
    let next: RecordingBlurRegion | null = null;
    if (rects && iw && ih) {
      next = viewDragToSourceBlurRegion(
        { x: drag.x0, y: drag.y0 },
        { x: drag.x1, y: drag.y1 },
        iw,
        ih,
        rects,
        blurStrength,
      );
    } else if (box && box.clientWidth > 0 && box.clientHeight > 0) {
      // Fallback if metadata isn't ready yet: treat the box as the full frame.
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      next = normalizeRecordingBlurRegion({
        x: Math.min(drag.x0, drag.x1) / bw,
        y: Math.min(drag.y0, drag.y1) / bh,
        w: Math.abs(drag.x1 - drag.x0) / bw,
        h: Math.abs(drag.y1 - drag.y0) / bh,
        strength: blurStrength,
      });
    }
    if (!next) return;
    pushUndo();
    onChange({ blurRegion: next });
    setBlurDrawMode(false);
  }

  function handleBlurPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled || !blurDrawMode) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = localPointFromEvent(e);
    const drag = { x0: x, y0: y, x1: x, y1: y };
    blurDragRef.current = drag;
    setBlurDrag(drag);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleBlurPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!blurDragRef.current) return;
    e.preventDefault();
    const { x, y } = localPointFromEvent(e);
    const next = { ...blurDragRef.current, x1: x, y1: y };
    blurDragRef.current = next;
    setBlurDrag(next);
  }

  function handleBlurPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!blurDragRef.current) return;
    e.preventDefault();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    commitBlurDrag();
  }

  function handleBlurPointerCancel() {
    blurDragRef.current = null;
    setBlurDrag(null);
  }

  function commitHighlightDrag() {
    const drag = highlightDragRef.current;
    highlightDragRef.current = null;
    setHighlightDrag(null);
    if (!drag) return;

    const minSide = Math.min(Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    if (minSide < 4) return;

    const v = previewRef.current;
    const box = previewBoxRef.current;
    const iw = previewVideoSize.w || v?.videoWidth || 0;
    const ih = previewVideoSize.h || v?.videoHeight || 0;
    const rects = previewCameraRects();
    let region: { x: number; y: number; w: number; h: number } | null = null;
    if (rects && iw && ih) {
      const blurLike = viewDragToSourceBlurRegion(
        { x: drag.x0, y: drag.y0 },
        { x: drag.x1, y: drag.y1 },
        iw,
        ih,
        rects,
        50,
      );
      if (blurLike) region = { x: blurLike.x, y: blurLike.y, w: blurLike.w, h: blurLike.h };
    } else if (box && box.clientWidth > 0 && box.clientHeight > 0) {
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      region = {
        x: Math.min(drag.x0, drag.x1) / bw,
        y: Math.min(drag.y0, drag.y1) / bh,
        w: Math.abs(drag.x1 - drag.x0) / bw,
        h: Math.abs(drag.y1 - drag.y0) / bh,
      };
    }
    if (!region) return;
    const next = normalizeRecordingHighlight({
      id: newRecordingHighlightId(),
      ...region,
      color: highlightColor,
      atMs: Math.round(playheadMs),
      drawMs: HIGHLIGHT_TOTAL_MS,
    });
    if (!next) return;
    pushUndo();
    onChange({
      highlights: normalizeRecordingHighlights([...highlights, next]),
    });
    setHighlightDrawMode(false);
  }

  function handleHighlightPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled || !highlightDrawMode) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = localPointFromEvent(e);
    const drag = { x0: x, y0: y, x1: x, y1: y };
    highlightDragRef.current = drag;
    setHighlightDrag(drag);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleHighlightPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!highlightDragRef.current) return;
    e.preventDefault();
    const { x, y } = localPointFromEvent(e);
    const next = { ...highlightDragRef.current, x1: x, y1: y };
    highlightDragRef.current = next;
    setHighlightDrag(next);
  }

  function handleHighlightPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!highlightDragRef.current) return;
    e.preventDefault();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    commitHighlightDrag();
  }

  function handleHighlightPointerCancel() {
    highlightDragRef.current = null;
    setHighlightDrag(null);
  }

  function handleClearAllHighlights() {
    if (disabled || highlights.length === 0) return;
    pushUndo();
    onChange({ highlights: [] });
  }

  function handleRemoveHighlight(id: string) {
    if (disabled) return;
    pushUndo();
    onChange({ highlights: highlights.filter((h) => h.id !== id) });
  }

  function handleClearBlur() {
    if (disabled || !blurRegion) return;
    pushUndo();
    onChange({ blurRegion: null });
    setBlurDrawMode(false);
  }

  function handleBlurStrength(value: number) {
    if (disabled || !blurRegion) return;
    onChange({
      blurRegion: normalizeRecordingBlurRegion({
        ...blurRegion,
        strength: clampBlurStrength(value),
      }),
    });
  }

  function handleScaleChange(value: number) {
    if (disabled) return;
    const next = applyRecordingCameraZoomAt(
      cameraKeyframes,
      playheadMs,
      {
        scale: value,
        focusX: camNow.focusX,
        focusY: camNow.focusY,
      },
      zoomDurationMs,
    );
    patchCamera(next);
    setSelectedCameraAtMs(Math.round(playheadMs));
  }

  function handleSplitAudio() {
    if (disabled || audioSegments.length === 0) return;
    const next = splitRecordingAudioAtClock(audioSegments, playheadMs);
    if (!next) return;
    stopPlayback();
    pushUndo();
    patchSegments(next);
    const under = next.find(
      (s) => playheadMs >= s.offsetMs && playheadMs <= s.offsetMs + recordingSegmentDurationMs(s),
    );
    if (under) {
      setSelectedAudioId(under.id);
      setSpeedTrack("audio");
    }
  }

  function handleDeleteSelectedAudio() {
    if (disabled || !selectedAudioId || audioSegments.length <= 1) return;
    stopPlayback();
    pushUndo();
    patchSegments(audioSegments.filter((s) => s.id !== selectedAudioId));
    setSelectedAudioId(null);
  }

  function handleSplitVideo() {
    if (disabled || videoSegments.length === 0) return;
    const next = splitRecordingVideoAtClock(videoSegments, playheadMs);
    if (!next) return;
    stopPlayback();
    pushUndo();
    patchVideoSegments(next);
    const under = next.find(
      (s) => playheadMs >= s.offsetMs && playheadMs <= s.offsetMs + recordingSegmentDurationMs(s),
    );
    if (under) {
      setSelectedVideoId(under.id);
      setSpeedTrack("video");
    }
  }

  function handleDeleteSelectedVideo() {
    if (disabled || !selectedVideoId || videoSegments.length <= 1) return;
    stopPlayback();
    pushUndo();
    patchVideoSegments(videoSegments.filter((s) => s.id !== selectedVideoId));
    setSelectedVideoId(null);
  }

  function handleSpeedChange(value: number) {
    if (disabled) return;
    const rate = clampPlaybackRate(value);
    if (speedTrack === "video") {
      if (!selectedVideoId) return;
      patchVideoSegments(
        videoSegments.map((s) => (s.id === selectedVideoId ? { ...s, rate } : s)),
      );
    } else {
      if (!selectedAudioId) return;
      patchSegments(
        audioSegments.map((s) => (s.id === selectedAudioId ? { ...s, rate } : s)),
      );
    }
  }

  useEffect(() => {
    if (!playing) {
      lastZoomSfxStartRef.current = null;
      return;
    }
    if (!zoomSfxUrl) return;
    const events = recordingCameraZoomEvents(cameraKeyframes);
    const hit = events.find(
      (ev) => playheadMs >= ev.startMs && playheadMs < ev.startMs + 80,
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
  }, [playing, playheadMs, cameraKeyframes, zoomSfxUrl]);

  const canSplitAudio = useMemo(() => {
    return audioSegments.some((s) => {
      const local = playheadMs - s.offsetMs;
      const dur = recordingSegmentDurationMs(s);
      return local > MIN_TRIM_MS && local < dur - MIN_TRIM_MS;
    });
  }, [audioSegments, playheadMs]);

  const canSplitVideo = useMemo(() => {
    return videoSegments.some((s) => {
      const local = playheadMs - s.offsetMs;
      const dur = recordingSegmentDurationMs(s);
      return local > MIN_TRIM_MS && local < dur - MIN_TRIM_MS;
    });
  }, [videoSegments, playheadMs]);

  const selectedAudioSeg = audioSegments.find((s) => s.id === selectedAudioId) ?? null;
  const selectedVideoSeg = videoSegments.find((s) => s.id === selectedVideoId) ?? null;
  const speedSeg = speedTrack === "video" ? selectedVideoSeg : selectedAudioSeg;

  const blurOverlay = useMemo(() => {
    if (blurDrag) {
      const left = Math.min(blurDrag.x0, blurDrag.x1);
      const top = Math.min(blurDrag.y0, blurDrag.y1);
      const width = Math.abs(blurDrag.x1 - blurDrag.x0);
      const height = Math.abs(blurDrag.y1 - blurDrag.y0);
      return { left, top, width, height, radius: 0, drafting: true as const };
    }

    if (!blurRegion || !previewCamera) return null;
    const iw = previewVideoSize.w;
    const ih = previewVideoSize.h;
    const view = sourceBlurRectToView(blurRegion, iw, ih, previewCamera.rects);
    if (!view) return null;
    return {
      ...view,
      radius: blurRadiusForStrength(
        blurRegion.strength,
        Math.min(view.width, view.height),
      ),
      drafting: false as const,
    };
  }, [previewCamera, previewVideoSize, blurRegion, blurDrag]);

  const highlightOverlays = useMemo(() => {
    type Overlay = {
      id: string;
      left: number;
      top: number;
      width: number;
      height: number;
      drafting: boolean;
      color: string;
      pathD: string | null;
      strokeProgress: number;
      opacity: number;
    };
    const out: Overlay[] = [];
    if (highlightDrag) {
      const left = Math.min(highlightDrag.x0, highlightDrag.x1);
      const top = Math.min(highlightDrag.y0, highlightDrag.y1);
      const width = Math.abs(highlightDrag.x1 - highlightDrag.x0);
      const height = Math.abs(highlightDrag.y1 - highlightDrag.y0);
      out.push({
        id: "draft",
        left,
        top,
        width,
        height,
        drafting: true,
        color: highlightColor,
        pathD: null,
        strokeProgress: 1,
        opacity: 1,
      });
    }
    if (!previewCamera) return out;
    const iw = previewVideoSize.w;
    const ih = previewVideoSize.h;
    for (const h of highlights) {
      const view = sourceHighlightRectToView(h, iw, ih, previewCamera.rects);
      if (!view) continue;
      const anim = highlightAnimAtMs(h, playheadMs);
      if (!anim.active) continue;
      out.push({
        id: h.id,
        ...view,
        drafting: false,
        color: h.color,
        pathD: handDrawnRectPathD(view.left, view.top, view.width, view.height, h.id),
        strokeProgress: anim.strokeProgress,
        opacity: anim.opacity,
      });
    }
    return out;
  }, [
    highlightDrag,
    highlights,
    previewCamera,
    previewVideoSize,
    highlightColor,
    playheadMs,
  ]);

  if (!draft.mediaUrl || source <= 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Upload a recording first to edit the sync timeline.
      </p>
    );
  }

  const playheadX = timeToX(playheadMs);
  const inVideoWindow = videoSegments.some((seg) => {
    const dur = recordingSegmentDurationMs(seg);
    const local = playheadMs - seg.offsetMs;
    return local >= 0 && local <= dur;
  });
  const inAudioWindow =
    recordingAudioSourceTimeSec(
      { recordingAudioSegments: audioSegments, recordingAudioSourceDurationMs: audioSource },
      playheadMs,
    ) != null;

  return (
    <div className="space-y-3">
      {draft.audioUrl && (
        <audio
          ref={audioRef}
          src={draft.audioUrl}
          preload="auto"
          playsInline
          // Safari can refuse to play media elements that are display:none.
          // `sr-only` keeps the element in the DOM without affecting layout.
          className="sr-only"
        />
      )}
      <audio ref={zoomSfxRef} preload="auto" className="sr-only" />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          Drag clips to place them. Pull edges to trim. Zoom in for millisecond cuts —{" "}
          <span className="font-medium text-foreground">Ctrl + scroll</span> (Mac:{" "}
          <span className="font-medium text-foreground">⌘ + scroll</span>).{" "}
          <span className="font-medium text-foreground">Space</span> plays/pauses.{" "}
          <span className="font-medium text-foreground">Ctrl/⌘ + Z</span> undoes.
        </p>
        <p className="tabular-nums">
          Scene <span className="font-medium text-foreground">{fmt(sceneMs)}</span>
          {" · "}
          Playhead{" "}
          <span className="font-medium text-foreground">
            {fmtClock(playheadMs, fineTicks)}
          </span>
          {audioSegments.length > 1 ? (
            <>
              {" · "}
              <span className="font-medium text-foreground">{audioSegments.length} audio clips</span>
            </>
          ) : null}
          {videoSegments.length > 1 ? (
            <>
              {" · "}
              <span className="font-medium text-foreground">{videoSegments.length} video clips</span>
            </>
          ) : null}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border bg-[#1a1b1e] text-white shadow-sm">
        {/* Preview + controls */}
          <div className="flex flex-col gap-3 border-b border-white/10 bg-black/40 p-3 lg:flex-row lg:items-stretch">
          <div
            ref={previewBoxRef}
            className={`relative mx-auto aspect-video w-full max-w-3xl overflow-hidden rounded-lg bg-black ring-1 ring-white/10 lg:mx-0 lg:w-[720px] lg:max-w-none lg:shrink-0 ${
              focusPickMode || blurDrawMode ? "cursor-crosshair ring-2 ring-violet-400" : ""
            } ${blurDrawMode ? "ring-sky-400" : ""}`}
            onClick={handlePreviewClick}
            title={
              blurDrawMode
                ? "Drag to set blur region"
                : focusPickMode
                  ? "Click to set zoom focus"
                  : undefined
            }
          >
            <video
              ref={previewRef}
              src={draft.mediaUrl}
              muted
              playsInline
              preload="auto"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              className={`pointer-events-none absolute max-w-none select-none ${
                isVideoClip ? "object-contain" : "object-fill"
              }`}
              style={
                previewCamera
                  ? {
                      left: previewCamera.videoLayout.left,
                      top: previewCamera.videoLayout.top,
                      width: previewCamera.videoLayout.width,
                      height: previewCamera.videoLayout.height,
                    }
                  : {
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      objectFit: isVideoClip ? "contain" : "contain",
                    }
              }
            />
            {blurOverlay && (
              <div
                className={`pointer-events-none absolute z-[1] border-2 ${
                  blurOverlay.drafting
                    ? "border-dashed border-sky-300 bg-sky-400/25"
                    : "border-sky-400/80"
                }`}
                style={{
                  left: blurOverlay.left,
                  top: blurOverlay.top,
                  width: Math.max(1, blurOverlay.width),
                  height: Math.max(1, blurOverlay.height),
                  backdropFilter:
                    !blurOverlay.drafting && blurOverlay.radius > 0
                      ? `blur(${blurOverlay.radius}px)`
                      : undefined,
                  WebkitBackdropFilter:
                    !blurOverlay.drafting && blurOverlay.radius > 0
                      ? `blur(${blurOverlay.radius}px)`
                      : undefined,
                }}
              />
            )}
            {highlightOverlays.length > 0 && (
              <svg
                className="pointer-events-none absolute inset-0 z-[1] h-full w-full overflow-visible"
                aria-hidden
              >
                {highlightOverlays.map((hv) =>
                  hv.drafting ? (
                    <rect
                      key={hv.id}
                      x={hv.left}
                      y={hv.top}
                      width={Math.max(1, hv.width)}
                      height={Math.max(1, hv.height)}
                      fill="none"
                      stroke={hv.color}
                      strokeWidth={3}
                      strokeDasharray="6 4"
                      opacity={0.9}
                    />
                  ) : hv.pathD ? (
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
                  ) : null,
                )}
              </svg>
            )}
            {blurDrawMode && (
              <div
                className="absolute inset-0 z-[2] cursor-crosshair touch-none"
                onPointerDown={handleBlurPointerDown}
                onPointerMove={handleBlurPointerMove}
                onPointerUp={handleBlurPointerUp}
                onPointerCancel={handleBlurPointerCancel}
              />
            )}
            {highlightDrawMode && (
              <div
                className="absolute inset-0 z-[2] cursor-crosshair touch-none"
                onPointerDown={handleHighlightPointerDown}
                onPointerMove={handleHighlightPointerMove}
                onPointerUp={handleHighlightPointerUp}
                onPointerCancel={handleHighlightPointerCancel}
              />
            )}
            {blurDrawMode && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-[3] bg-sky-600/80 px-2 py-1 text-center text-[10px] font-medium text-white">
                Drag a rectangle over the area to blur
              </div>
            )}
            {highlightDrawMode && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-[3] bg-rose-600/80 px-2 py-1 text-center text-[10px] font-medium text-white">
                Drag a rectangle — it will draw on at the playhead, then fade out in 1s
              </div>
            )}
            {focusPickMode && !blurDrawMode && !highlightDrawMode && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-[3] bg-violet-600/80 px-2 py-1 text-center text-[10px] font-medium text-white">
                Click on the area to zoom into
              </div>
            )}
            {!focusPickMode && !blurDrawMode && !highlightDrawMode && previewCamera?.focusView && (
              <div
                className="pointer-events-none absolute z-[1] h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-violet-300 bg-violet-500/40"
                style={{
                  left: previewCamera.focusView.left,
                  top: previewCamera.focusView.top,
                }}
              />
            )}
            {!inVideoWindow && (
              <div className="absolute inset-0 z-[4] flex items-center justify-center bg-black/55 text-xs text-white/70">
                Outside video cut
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!canPlay}
                onClick={togglePlay}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-black shadow transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
                title={playing ? "Pause (Space)" : "Play sync preview (Space)"}
                aria-label={playing ? "Pause" : "Play sync preview"}
              >
                {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
              </button>
              <button
                type="button"
                disabled={!canPlay || disabled}
                onClick={restartPlayback}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                title="Restart from beginning"
                aria-label="Restart from beginning"
              >
                <RotateCcw size={15} />
              </button>
              <button
                type="button"
                disabled={disabled || undoDepth <= 0}
                onClick={undoTimeline}
                className="inline-flex h-9 items-center gap-1 rounded-full px-2.5 text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                title="Undo (Ctrl/⌘ + Z)"
                aria-label="Undo last timeline edit"
              >
                <Undo2 size={15} />
                <span className="text-[10px] font-medium">Undo</span>
              </button>
              {!cameraBlurOnly && (
                <>
              <button
                type="button"
                disabled={disabled || !canSplitAudio}
                onClick={handleSplitAudio}
                className="inline-flex items-center gap-1.5 rounded-md bg-sky-500/90 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
                title="Split the audio clip at the red playhead"
              >
                <Scissors size={14} />
                Split audio
              </button>
              {audioSegments.length > 1 && (
                <button
                  type="button"
                  disabled={disabled || !selectedAudioId || audioSegments.length <= 1}
                  onClick={handleDeleteSelectedAudio}
                  className="rounded-md border border-white/20 px-3 py-2 text-xs text-white/80 hover:bg-white/10 disabled:opacity-40"
                >
                  Delete selected audio
                </button>
              )}
              <button
                type="button"
                disabled={disabled || !canSplitVideo}
                onClick={handleSplitVideo}
                className="inline-flex items-center gap-1.5 rounded-md bg-orange-500/90 px-3 py-2 text-xs font-semibold text-white transition hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
                title="Split the video clip at the red playhead"
              >
                <Scissors size={14} />
                Split video
              </button>
              {videoSegments.length > 1 && (
                <button
                  type="button"
                  disabled={disabled || !selectedVideoId || videoSegments.length <= 1}
                  onClick={handleDeleteSelectedVideo}
                  className="rounded-md border border-white/20 px-3 py-2 text-xs text-white/80 hover:bg-white/10 disabled:opacity-40"
                >
                  Delete selected video
                </button>
              )}
                </>
              )}
            </div>

            <div className="rounded-lg border border-white/10 bg-white/5 p-2.5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-300">
                  Camera
                </span>
                <span className="text-[11px] tabular-nums text-white/60">
                  {camNow.scale.toFixed(2)}×
                </span>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      handleAddCameraKeyframe(
                        Math.min(RECORDING_CAMERA_MAX_SCALE, camNow.scale + 0.5),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-violet-500/90 px-2 py-1 text-[10px] font-semibold text-white hover:bg-violet-400 disabled:opacity-40"
                  >
                    <ZoomIn size={12} />
                    Zoom in
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={handleResetCamera}
                    className="inline-flex items-center gap-1 rounded-md border border-white/20 px-2 py-1 text-[10px] text-white/80 hover:bg-white/10 disabled:opacity-40"
                  >
                    <ZoomOut size={12} />
                    Full
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setBlurDrawMode(false);
                      setHighlightDrawMode(false);
                      setFocusPickMode((v) => !v);
                    }}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold disabled:opacity-40 ${
                      focusPickMode
                        ? "bg-violet-400 text-black"
                        : "border border-white/20 text-white/80 hover:bg-white/10"
                    }`}
                  >
                    <Focus size={12} />
                    Set focus
                  </button>
                  <button
                    type="button"
                    disabled={disabled || selectedCameraAtMs == null || selectedCameraAtMs <= 0}
                    onClick={handleDeleteCameraKeyframe}
                    className="inline-flex items-center gap-1 rounded-md border border-white/20 px-2 py-1 text-[10px] text-white/80 hover:bg-white/10 disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                    Delete KF
                  </button>
                </div>
              </div>
              <div className="mb-2 grid gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-[11px] text-white/70">
                  <span className="w-16 shrink-0">Zoom time</span>
                  <input
                    type="number"
                    min={MIN_CAMERA_ZOOM_DURATION_MS / 1000}
                    max={MAX_CAMERA_ZOOM_DURATION_MS / 1000}
                    step={0.1}
                    value={Number((zoomDurationMs / 1000).toFixed(2))}
                    disabled={disabled}
                    onChange={(e) => {
                      const sec = Number(e.target.value);
                      if (!Number.isFinite(sec)) return;
                      pushUndo();
                      onChange({
                        cameraZoomDurationMs: clampCameraZoomDurationMs(sec * 1000),
                      });
                    }}
                    className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs tabular-nums text-white"
                  />
                  <span className="shrink-0 text-white/40">sec</span>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-white/70">
                  <span className="w-16 shrink-0">Zoom SFX</span>
                  <select
                    value={zoomSfx}
                    disabled={disabled}
                    onChange={(e) => {
                      pushUndo();
                      onChange({
                        cameraZoomSfx: normalizeRecordingCameraZoomSfx(e.target.value),
                      });
                    }}
                    className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs text-white"
                  >
                    {RECORDING_CAMERA_ZOOM_SFX_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-white/70">
                <span className="w-10 shrink-0">Scale</span>
                <input
                  type="range"
                  min={RECORDING_CAMERA_MIN_SCALE}
                  max={RECORDING_CAMERA_MAX_SCALE}
                  step={0.05}
                  value={camNow.scale}
                  disabled={disabled}
                  onPointerDown={() => {
                    if (!disabled) pushUndo();
                  }}
                  onChange={(e) => handleScaleChange(Number(e.target.value))}
                  className="h-1.5 w-full accent-violet-400"
                />
              </label>
              <p className="mt-1.5 text-[10px] text-white/45">
                Set focus on the preview, then zoom. Zoom time controls how fast the move finishes.
                Markers on the Camera track animate between keyframes.
              </p>
            </div>

            <div className="rounded-lg border border-white/10 bg-white/5 p-2.5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                  Blur
                </span>
                <span className="text-[11px] text-white/55">
                  {blurRegion ? "On (whole scene)" : "Off"}
                </span>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setFocusPickMode(false);
                      setHighlightDrawMode(false);
                      setBlurDrawMode((v) => !v);
                    }}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold disabled:opacity-40 ${
                      blurDrawMode
                        ? "bg-sky-400 text-black"
                        : "border border-white/20 text-white/80 hover:bg-white/10"
                    }`}
                  >
                    <SquareDashedMousePointer size={12} />
                    {blurRegion ? "Redraw" : "Draw region"}
                  </button>
                  <button
                    type="button"
                    disabled={disabled || !blurRegion}
                    onClick={handleClearBlur}
                    className="inline-flex items-center gap-1 rounded-md border border-white/20 px-2 py-1 text-[10px] text-white/80 hover:bg-white/10 disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                    Clear
                  </button>
                </div>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-white/70">
                <span className="w-14 shrink-0">Strength</span>
                <input
                  type="range"
                  min={MIN_BLUR_STRENGTH}
                  max={MAX_BLUR_STRENGTH}
                  step={1}
                  value={blurStrength}
                  disabled={disabled || !blurRegion}
                  onPointerDown={() => {
                    if (!disabled && blurRegion) pushUndo();
                  }}
                  onChange={(e) => handleBlurStrength(Number(e.target.value))}
                  className="h-1.5 w-full accent-sky-400 disabled:opacity-40"
                />
                <span className="w-8 shrink-0 tabular-nums text-white/50">{blurStrength}</span>
              </label>
              <p className="mt-1.5 text-[10px] text-white/45">
                Set once at any zoom — the blur stays on the same video content when you zoom in or out.
              </p>
            </div>

            {cameraBlurOnly && (
              <div className="rounded-lg border border-white/10 bg-white/5 p-2.5">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-rose-300">
                    Highlight
                  </span>
                  <span className="text-[11px] text-white/55">
                    {highlights.length
                      ? `${highlights.length} · ${HIGHLIGHT_TOTAL_MS / 1000}s each at playhead`
                      : "Off"}
                  </span>
                  <div className="ml-auto flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setFocusPickMode(false);
                        setBlurDrawMode(false);
                        setHighlightDrawMode((v) => !v);
                      }}
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold disabled:opacity-40 ${
                        highlightDrawMode
                          ? "bg-rose-400 text-black"
                          : "border border-white/20 text-white/80 hover:bg-white/10"
                      }`}
                    >
                      <SquareDashedMousePointer size={12} />
                      Draw region
                    </button>
                    <button
                      type="button"
                      disabled={disabled || highlights.length === 0}
                      onClick={handleClearAllHighlights}
                      className="inline-flex items-center gap-1 rounded-md border border-white/20 px-2 py-1 text-[10px] text-white/80 hover:bg-white/10 disabled:opacity-40"
                    >
                      <Trash2 size={12} />
                      Clear all
                    </button>
                  </div>
                </div>
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span className="w-14 shrink-0 text-[11px] text-white/70">Color</span>
                  {HIGHLIGHT_COLOR_PRESETS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      disabled={disabled}
                      title={c}
                      onClick={() => setHighlightColor(c)}
                      className={`h-6 w-6 rounded-full border-2 disabled:opacity-40 ${
                        highlightColor === c ? "border-white" : "border-white/20"
                      }`}
                      style={{ background: c }}
                    />
                  ))}
                  <input
                    type="color"
                    value={highlightColor}
                    disabled={disabled}
                    onChange={(e) => {
                      setHighlightColor(normalizeHighlightColor(e.target.value));
                    }}
                    className="h-6 w-8 cursor-pointer rounded border border-white/20 bg-transparent disabled:opacity-40"
                    title="Custom color"
                  />
                </div>
                {highlights.length > 0 && (
                  <ul className="mb-2 max-h-28 space-y-1 overflow-y-auto">
                    {highlights.map((h, i) => (
                      <li
                        key={h.id}
                        className="flex items-center gap-2 rounded-md border border-white/10 bg-black/25 px-2 py-1 text-[11px] text-white/75"
                      >
                        <span
                          className="h-3 w-3 shrink-0 rounded-sm border border-white/30"
                          style={{ background: h.color }}
                          aria-hidden
                        />
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left hover:text-white"
                          title="Jump playhead to this highlight"
                          onClick={() => setPlayheadMs(h.atMs)}
                        >
                          #{i + 1} · {fmtClock(h.atMs)} · 1s
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => handleRemoveHighlight(h.id)}
                          className="shrink-0 text-white/45 hover:text-rose-300 disabled:opacity-40"
                          title="Remove highlight"
                        >
                          <Trash2 size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1.5 text-[10px] text-white/45">
                  Scrub the red playhead, then draw a region — it plays for 1s at that time
                  (stroke in, then fade). Add as many as you need at different times.
                </p>
              </div>
            )}

            {!cameraBlurOnly && speedSeg && (
              <div className="rounded-lg border border-white/10 bg-white/5 p-2.5">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                    Speed
                  </span>
                  <span className="text-[11px] tabular-nums text-white/60">
                    {clampPlaybackRate(speedSeg.rate).toFixed(2)}×
                  </span>
                  <span className="ml-auto text-[10px] text-white/40">
                    {speedTrack === "video" ? "Selected video clip" : "Selected audio clip"}
                  </span>
                </div>
                <label className="flex items-center gap-2 text-[11px] text-white/70">
                  <span className="w-10 shrink-0">Rate</span>
                  <input
                    type="range"
                    min={MIN_PLAYBACK_RATE}
                    max={MAX_PLAYBACK_RATE}
                    step={0.05}
                    value={clampPlaybackRate(speedSeg.rate)}
                    disabled={disabled}
                    onPointerDown={() => {
                      if (!disabled) pushUndo();
                    }}
                    onChange={(e) => handleSpeedChange(Number(e.target.value))}
                    className="h-1.5 w-full accent-emerald-400"
                  />
                </label>
                <p className="mt-1.5 text-[10px] text-white/45">
                  Stretches or compresses this clip on the timeline. 1.00× is original speed.
                </p>
              </div>
            )}

            <div>
              <div className="text-lg font-medium tabular-nums tracking-tight">
                {fmtClock(playheadMs)}
                <span className="mx-1.5 text-white/30">/</span>
                <span className="text-white/50">{fmtClock(sceneMs)}</span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-white/55">
                {cameraBlurOnly
                  ? playing
                    ? "Playing preview. Add zoom keyframes and draw a blur region."
                    : "Scrub the playhead, zoom in at key moments, and blur sensitive areas."
                  : audioSource > 0
                    ? playing
                      ? "Playing both tracks. Drag the red line to scrub."
                      : inAudioWindow
                        ? "Playhead is inside a narration clip — Split audio cuts here."
                        : "Drag the red playhead, then Split audio to cut narration into pieces."
                    : "Generate TTS first."}
              </p>
            </div>
          </div>
        </div>

        {/* Timeline */}
        <div className="px-2 pb-3 pt-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-white/50">
              Timeline zoom
            </span>
            <div className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 p-0.5">
              <button
                type="button"
                title="Zoom out (Ctrl + scroll down)"
                aria-label="Zoom timeline out"
                disabled={timelineZoom <= TIMELINE_ZOOM_MIN}
                onClick={() => applyTimelineZoom(timelineZoom / 1.35)}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-white/80 hover:bg-white/10 disabled:opacity-35"
              >
                <ZoomOut size={14} />
              </button>
              <span className="min-w-[3.25rem] text-center text-[11px] tabular-nums text-white/80">
                {timelineZoom < 10 ? timelineZoom.toFixed(1) : Math.round(timelineZoom)}×
              </span>
              <button
                type="button"
                title="Zoom in (Ctrl + scroll up)"
                aria-label="Zoom timeline in"
                disabled={timelineZoom >= TIMELINE_ZOOM_MAX}
                onClick={() => applyTimelineZoom(timelineZoom * 1.35)}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-white/80 hover:bg-white/10 disabled:opacity-35"
              >
                <ZoomIn size={14} />
              </button>
            </div>
            <input
              type="range"
              min={TIMELINE_ZOOM_MIN}
              max={TIMELINE_ZOOM_MAX}
              step={0.1}
              value={timelineZoom}
              onChange={(e) => applyTimelineZoom(Number(e.target.value))}
              className="h-1.5 w-28 cursor-pointer accent-sky-400 sm:w-40"
              title="Timeline zoom"
              aria-label="Timeline zoom level"
            />
            <button
              type="button"
              onClick={() => {
                setTimelineZoom(1);
                if (scrollRef.current) scrollRef.current.scrollLeft = 0;
              }}
              disabled={timelineZoom <= TIMELINE_ZOOM_MIN}
              className="rounded-md border border-white/15 px-2 py-1 text-[10px] text-white/70 hover:bg-white/10 disabled:opacity-35"
            >
              Fit
            </button>
            <span className="text-[10px] text-white/40">
              Ctrl/⌘ + scroll · finer ticks when zoomed
            </span>
          </div>

          <div className="flex">
            <div
              className="shrink-0 select-none pt-[28px] text-[10px] font-medium uppercase tracking-wide text-white/40"
              style={{ width: LABEL_W }}
            >
              {!cameraBlurOnly && (
                <>
                  <div className="flex h-11 items-center">Audio</div>
                  <div className="mt-1.5 flex h-11 items-center">Video</div>
                </>
              )}
              <div
                className={`flex h-11 items-center text-violet-300/80 ${
                  cameraBlurOnly ? "" : "mt-1.5"
                }`}
              >
                Cam
              </div>
            </div>

            <div
              ref={scrollRef}
              className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
              onWheel={onTimelineWheel}
            >
              <div style={{ width: contentWidth, minWidth: "100%" }}>
              <div
                className="relative cursor-col-resize select-none"
                style={{ height: RULER_H }}
                onPointerDown={(e) => beginDrag({ kind: "scrub" }, e)}
              >
                <div className="absolute inset-x-0 bottom-0 h-px bg-white/15" />
                {ticks.map((t) => (
                  <div
                    key={t}
                    className="absolute bottom-0 flex flex-col items-center"
                    style={{ left: timeToX(t) }}
                  >
                    <span className="mb-0.5 -translate-x-1/2 whitespace-nowrap text-[9px] tabular-nums text-white/45">
                      {fmtClock(t, fineTicks)}
                    </span>
                    <span className="h-2 w-px bg-white/25" />
                  </div>
                ))}
              </div>

              <div
                ref={trackRef}
                className="relative select-none"
                style={{ height: tracksHeight, width: contentWidth }}
              >
                {!cameraBlurOnly && (
                  <>
                <div
                  className="absolute inset-x-0 cursor-col-resize rounded-md bg-white/[0.04]"
                  style={{ top: 0, height: TRACK_H }}
                  onPointerDown={(e) => beginDrag({ kind: "scrub" }, e)}
                />
                <div
                  className="absolute inset-x-0 cursor-col-resize rounded-md bg-white/[0.04]"
                  style={{ top: TRACK_H + 6, height: TRACK_H }}
                  onPointerDown={(e) => beginDrag({ kind: "scrub" }, e)}
                />
                  </>
                )}
                <div
                  className="absolute inset-x-0 cursor-col-resize rounded-md bg-violet-500/10"
                  style={{ top: camTrackTop, height: TRACK_H }}
                  onPointerDown={(e) => beginDrag({ kind: "scrub" }, e)}
                />

                {!cameraBlurOnly && audioSegments.length === 0 && (
                  <div
                    className="absolute z-[1] flex items-center rounded-md bg-sky-500/20 px-2 text-[10px] text-white/50"
                    style={{ top: 4, left: 0, width: 120, height: TRACK_H - 8 }}
                  >
                    No narration
                  </div>
                )}

                {!cameraBlurOnly && videoSegments.length === 0 && (
                  <div
                    className="absolute z-[1] flex items-center rounded-md bg-orange-500/20 px-2 text-[10px] text-white/50"
                    style={{ top: TRACK_H + 10, left: 0, width: 120, height: TRACK_H - 8 }}
                  >
                    No video
                  </div>
                )}

                {!cameraBlurOnly &&
                audioSegments.map((seg, i) => {
                  const dur = recordingSegmentDurationMs(seg);
                  const left = timeToX(seg.offsetMs);
                  const width = Math.max(HANDLE_W * 2 + 8, dur * pxPerMs);
                  const selected = seg.id === selectedAudioId;
                  const draggingThis =
                    dragging?.kind === "audio" && dragging.id === seg.id;
                  return (
                    <div
                      key={seg.id}
                      data-clip={`audio-${seg.id}`}
                      className={`absolute z-[2] overflow-hidden rounded-md ${
                        disabled || audioSource <= 0 ? "pointer-events-none opacity-50" : ""
                      } ${draggingThis && dragging.mode === "move" ? "cursor-grabbing" : "cursor-grab"}`}
                      style={{
                        top: 4,
                        left,
                        width,
                        height: TRACK_H - 8,
                        background:
                          "linear-gradient(180deg, #38bdf8 0%, #0ea5e9 55%, #0284c7 100%)",
                        boxShadow: selected || draggingThis
                          ? "0 0 0 2px #fff, 0 8px 20px rgba(0,0,0,0.35)"
                          : "inset 0 0 0 1px rgba(255,255,255,0.25), 0 2px 8px rgba(0,0,0,0.25)",
                      }}
                      onPointerDown={(e) =>
                        beginDrag({ kind: "audio", id: seg.id, mode: "move" }, e)
                      }
                    >
                      <WaveformBars />
                      <div className="pointer-events-none absolute inset-0 flex items-center px-2">
                        <span className="truncate text-[10px] font-semibold text-white drop-shadow">
                          {audioSegments.length > 1 ? `Clip ${i + 1} · ` : ""}
                          {fmt(dur)} · {clampPlaybackRate(seg.rate).toFixed(2)}×
                        </span>
                      </div>
                      <TrimHandle
                        side="left"
                        disabled={disabled || audioSource <= 0}
                        onPointerDown={(e) =>
                          beginDrag({ kind: "audio", id: seg.id, mode: "trim-left" }, e)
                        }
                      />
                      <TrimHandle
                        side="right"
                        disabled={disabled || audioSource <= 0}
                        onPointerDown={(e) =>
                          beginDrag({ kind: "audio", id: seg.id, mode: "trim-right" }, e)
                        }
                      />
                    </div>
                  );
                })}

                {!cameraBlurOnly &&
                videoSegments.map((seg, i) => {
                  const dur = recordingSegmentDurationMs(seg);
                  const left = timeToX(seg.offsetMs);
                  const width = Math.max(HANDLE_W * 2 + 8, dur * pxPerMs);
                  const selected = seg.id === selectedVideoId;
                  const draggingThis =
                    dragging?.kind === "video" && dragging.id === seg.id;
                  return (
                    <div
                      key={seg.id}
                      data-clip={`video-${seg.id}`}
                      className={`absolute z-[2] overflow-hidden rounded-md ${
                        disabled ? "pointer-events-none opacity-60" : ""
                      } ${draggingThis && dragging.mode === "move" ? "cursor-grabbing" : "cursor-grab"}`}
                      style={{
                        top: TRACK_H + 10,
                        left,
                        width,
                        height: TRACK_H - 8,
                        background:
                          "linear-gradient(180deg, #fb923c 0%, #f97316 50%, #ea580c 100%)",
                        boxShadow: selected || draggingThis
                          ? "0 0 0 2px #fff, 0 8px 20px rgba(0,0,0,0.35)"
                          : "inset 0 0 0 1px rgba(255,255,255,0.25), 0 2px 8px rgba(0,0,0,0.25)",
                      }}
                      onPointerDown={(e) =>
                        beginDrag({ kind: "video", id: seg.id, mode: "move" }, e)
                      }
                    >
                      <FilmstripPattern />
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3">
                        <span className="truncate text-[10px] font-semibold text-white drop-shadow">
                          {videoSegments.length > 1 ? `Clip ${i + 1} · ` : ""}
                          {fmt(dur)} · {clampPlaybackRate(seg.rate).toFixed(2)}×
                        </span>
                      </div>
                      <TrimHandle
                        side="left"
                        disabled={disabled}
                        onPointerDown={(e) =>
                          beginDrag({ kind: "video", id: seg.id, mode: "trim-left" }, e)
                        }
                      />
                      <TrimHandle
                        side="right"
                        disabled={disabled}
                        onPointerDown={(e) =>
                          beginDrag({ kind: "video", id: seg.id, mode: "trim-right" }, e)
                        }
                      />
                    </div>
                  );
                })}

                {cameraKeyframes.map((kf) => {
                  const selected =
                    selectedCameraAtMs != null && Math.abs(selectedCameraAtMs - kf.atMs) <= 40;
                  const draggingThis =
                    dragging?.kind === "camera" && Math.abs(dragging.atMs - kf.atMs) <= 40;
                  return (
                    <button
                      key={`cam-${kf.atMs}`}
                      type="button"
                      disabled={disabled}
                      title={`${kf.scale.toFixed(2)}× at ${fmtClock(kf.atMs)}`}
                      className={`absolute z-[2] flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full text-[9px] font-bold text-white shadow transition disabled:opacity-50 ${
                        selected || draggingThis
                          ? "bg-violet-400 ring-2 ring-white"
                          : "bg-violet-600 ring-1 ring-violet-200/40 hover:bg-violet-500"
                      } ${kf.atMs <= 0 ? "cursor-default" : "cursor-ew-resize"}`}
                      style={{
                        top: camTrackTop + (TRACK_H - 28) / 2,
                        left: timeToX(kf.atMs),
                      }}
                      onPointerDown={(e) => {
                        if (kf.atMs <= 0) {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedCameraAtMs(kf.atMs);
                          setPlayheadMs(kf.atMs);
                          return;
                        }
                        beginDrag({ kind: "camera", atMs: kf.atMs }, e);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedCameraAtMs(kf.atMs);
                        setPlayheadMs(kf.atMs);
                      }}
                    >
                      {kf.scale.toFixed(2)}
                    </button>
                  );
                })}

                {cameraBlurOnly &&
                  highlights.map((h) => (
                    <button
                      key={`hl-${h.id}`}
                      type="button"
                      disabled={disabled}
                      title={`Highlight at ${fmtClock(h.atMs)} (1s)`}
                      className="absolute z-[3] h-2.5 w-2.5 -translate-x-1/2 rounded-sm border border-white/70 shadow disabled:opacity-50"
                      style={{
                        top: camTrackTop + TRACK_H - 10,
                        left: timeToX(h.atMs),
                        background: h.color,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPlayheadMs(h.atMs);
                      }}
                    />
                  ))}

                {/* Draggable playhead — wide hit target */}
                <div
                  className="absolute top-0 z-30 cursor-ew-resize"
                  style={{
                    left: playheadX,
                    height: tracksHeight,
                    width: 16,
                    transform: "translateX(-50%)",
                  }}
                  onPointerDown={(e) => beginDrag({ kind: "scrub" }, e)}
                  title="Drag to scrub"
                >
                  <div className="mx-auto h-3 w-3 rounded-full bg-rose-400 shadow ring-2 ring-rose-200/40" />
                  <div className="mx-auto h-full w-0.5 bg-rose-400" />
                </div>
              </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          Video offset{" "}
          <span className="font-medium text-foreground">
            {(videoSegments[0]?.offsetMs ?? 0) >= 0
              ? `+${fmt(videoSegments[0]?.offsetMs ?? 0)}`
              : fmt(videoSegments[0]?.offsetMs ?? 0)}
          </span>
        </span>
        <span>
          Video cut{" "}
          <span className="font-medium text-foreground">
            {fmtClock(videoSegments[0]?.trimStartMs ?? 0, fineTicks)}–
            {fmtClock(videoSegments[0]?.trimEndMs ?? source, fineTicks)}
          </span>
        </span>
        <button
          type="button"
          disabled={disabled}
          className="text-primary hover:underline disabled:opacity-50"
          onClick={() => {
            pushUndo();
            onChange({
              ...legacyVideoFieldsFromSegments([singleRecordingVideoSegment(source)]),
              audioSegments:
                audioSource > 0
                  ? [
                      {
                        id: audioSegments[0]?.id ?? `aud-${Date.now()}`,
                        trimStartMs: 0,
                        trimEndMs: audioSource,
                        offsetMs: 0,
                        rate: DEFAULT_PLAYBACK_RATE,
                      },
                    ]
                  : [],
            });
            setSelectedAudioId(null);
            setSelectedVideoId(null);
          }}
        >
          Reset all cuts & positions
        </button>
        <button
          type="button"
          disabled={disabled || videoSegments.length === 0}
          className="text-primary hover:underline disabled:opacity-50"
          onClick={() => {
            pushUndo();
            patchVideoSegments([singleRecordingVideoSegment(source)]);
            setSelectedVideoId(null);
          }}
        >
          Reset video
        </button>
      </div>
    </div>
  );
}

function TrimHandle({
  side,
  disabled,
  onPointerDown,
}: {
  side: "left" | "right";
  disabled?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Trim start" : "Trim end"}
      disabled={disabled}
      className={`absolute inset-y-0 z-10 flex cursor-ew-resize items-center justify-center bg-black/25 hover:bg-black/40 ${
        side === "left" ? "left-0" : "right-0"
      }`}
      style={{ width: HANDLE_W }}
      onPointerDown={onPointerDown}
    >
      <span className="h-5 w-0.5 rounded-full bg-white/90" />
    </button>
  );
}

function WaveformBars() {
  const bars = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => {
        const t = i / 48;
        return 0.25 + 0.55 * Math.abs(Math.sin(t * 17.2) * Math.cos(t * 5.1));
      }),
    [],
  );
  return (
    <div className="absolute inset-0 flex items-center gap-px px-2 opacity-40">
      {bars.map((h, i) => (
        <span key={i} className="flex-1 rounded-sm bg-white" style={{ height: `${h * 100}%` }} />
      ))}
    </div>
  );
}

function FilmstripPattern() {
  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-30"
      style={{
        backgroundImage:
          "repeating-linear-gradient(90deg, transparent 0 14px, rgba(0,0,0,0.35) 14px 16px)",
      }}
    />
  );
}
