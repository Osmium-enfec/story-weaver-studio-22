/** Pan/zoom camera keyframes for screen-recording scenes (scene clock). */

export type RecordingCameraEasing = "linear" | "easeInOut";
export type RecordingCameraZoomSfx = "swoosh" | "none";

export interface RecordingCameraKeyframe {
  /** Scene clock ms (same playhead as RecordingTimeline). */
  atMs: number;
  /** 1 = full frame; up to RECORDING_CAMERA_MAX_SCALE. */
  scale: number;
  /** Focus in source video, 0–1. */
  focusX: number;
  focusY: number;
  easing?: RecordingCameraEasing;
}

export interface RecordingCameraState {
  scale: number;
  focusX: number;
  focusY: number;
}

export interface RecordingCameraDrawRects {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface RecordingCameraZoomEvent {
  /** When the zoom transition starts (scene clock). */
  startMs: number;
  /** When the zoom reaches the target keyframe. */
  endMs: number;
  fromScale: number;
  toScale: number;
}

export const RECORDING_CAMERA_MAX_SCALE = 3;
export const RECORDING_CAMERA_MIN_SCALE = 1;
/** Default length of a zoom in/out move (ms). */
export const DEFAULT_CAMERA_ZOOM_DURATION_MS = 500;
export const MIN_CAMERA_ZOOM_DURATION_MS = 100;
export const MAX_CAMERA_ZOOM_DURATION_MS = 5000;
export const RECORDING_CAMERA_ZOOM_SFX_URL = "/sfx/transition-swoosh.mp3";
export const DEFAULT_CAMERA_ZOOM_SFX: RecordingCameraZoomSfx = "swoosh";

export const RECORDING_CAMERA_ZOOM_SFX_OPTIONS: {
  id: RecordingCameraZoomSfx;
  label: string;
  url: string | null;
}[] = [
  { id: "none", label: "None", url: null },
  { id: "swoosh", label: "Swoosh", url: RECORDING_CAMERA_ZOOM_SFX_URL },
];

export const DEFAULT_RECORDING_CAMERA_KEYFRAME: RecordingCameraKeyframe = {
  atMs: 0,
  scale: 1,
  focusX: 0.5,
  focusY: 0.5,
  easing: "easeInOut",
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function applyEasing(t: number, easing: RecordingCameraEasing | undefined): number {
  const x = clamp(t, 0, 1);
  if (easing === "linear") return x;
  return easeInOut(x);
}

export function clampCameraZoomDurationMs(ms: number): number {
  return clamp(
    Math.round(ms),
    MIN_CAMERA_ZOOM_DURATION_MS,
    MAX_CAMERA_ZOOM_DURATION_MS,
  );
}

export function normalizeRecordingCameraZoomSfx(
  raw: string | null | undefined,
): RecordingCameraZoomSfx {
  return raw === "none" ? "none" : "swoosh";
}

export function recordingCameraZoomSfxUrl(
  sfx: RecordingCameraZoomSfx | null | undefined,
): string | null {
  const id = normalizeRecordingCameraZoomSfx(sfx);
  return RECORDING_CAMERA_ZOOM_SFX_OPTIONS.find((o) => o.id === id)?.url ?? null;
}

export function normalizeRecordingCameraKeyframes(
  raw: RecordingCameraKeyframe[] | null | undefined,
): RecordingCameraKeyframe[] {
  if (!raw?.length) return [{ ...DEFAULT_RECORDING_CAMERA_KEYFRAME }];
  const cleaned: RecordingCameraKeyframe[] = raw
    .map((k) => ({
      atMs: Math.max(0, Math.round(k.atMs)),
      scale: clamp(k.scale, RECORDING_CAMERA_MIN_SCALE, RECORDING_CAMERA_MAX_SCALE),
      focusX: clamp(k.focusX, 0, 1),
      focusY: clamp(k.focusY, 0, 1),
      easing: (k.easing === "linear" ? "linear" : "easeInOut") as RecordingCameraEasing,
    }))
    .sort((a, b) => a.atMs - b.atMs);

  // One keyframe per timestamp (keep last) — avoids stacked markers at t=0.
  const deduped: RecordingCameraKeyframe[] = [];
  for (const k of cleaned) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.atMs - k.atMs) <= 40) {
      deduped[deduped.length - 1] = k;
    } else {
      deduped.push(k);
    }
  }

  if (deduped.length === 0) return [{ ...DEFAULT_RECORDING_CAMERA_KEYFRAME }];
  if (deduped[0]!.atMs > 0) {
    deduped.unshift({ ...DEFAULT_RECORDING_CAMERA_KEYFRAME, easing: "easeInOut" });
  }
  return deduped;
}

/**
 * Interpolate camera at a scene-clock position.
 * Zoom in locks focus on the destination immediately (no center→pan).
 * Zoom out locks focus on the source region.
 */
export function recordingCameraAt(
  keyframes: RecordingCameraKeyframe[] | null | undefined,
  elapsedMs: number,
): RecordingCameraState {
  const keys = normalizeRecordingCameraKeyframes(keyframes);
  const t = Math.max(0, elapsedMs);
  if (t <= keys[0]!.atMs) {
    const k = keys[0]!;
    return { scale: k.scale, focusX: k.focusX, focusY: k.focusY };
  }
  const last = keys[keys.length - 1]!;
  if (t >= last.atMs) {
    return { scale: last.scale, focusX: last.focusX, focusY: last.focusY };
  }
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1]!.atMs < t) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const span = Math.max(1, b.atMs - a.atMs);
  const u = applyEasing((t - a.atMs) / span, b.easing ?? a.easing);
  const scale = a.scale + (b.scale - a.scale) * u;

  // Direct zoom: aim at the target region while scaling (no center-then-pan).
  const zoomingIn = b.scale > a.scale + 0.02;
  const zoomingOut = b.scale < a.scale - 0.02;
  let focusX: number;
  let focusY: number;
  if (zoomingIn) {
    focusX = b.focusX;
    focusY = b.focusY;
  } else if (zoomingOut) {
    focusX = a.focusX;
    focusY = a.focusY;
  } else {
    focusX = a.focusX + (b.focusX - a.focusX) * u;
    focusY = a.focusY + (b.focusY - a.focusY) * u;
  }

  return { scale, focusX, focusY };
}

/**
 * Source crop + destination rect for canvas draw.
 * - cover: fill dest, preserve aspect (may crop)
 * - contain: fit inside dest, preserve aspect (may letterbox/pillarbox)
 * - fill: stretch crop to exact dest (no letterbox/pillarbox; may distort)
 * At scale>1 the crop is a zoomed region fitted the same way.
 */
export type RecordingCameraFit = "cover" | "contain" | "fill";

export function recordingCameraDrawRects(
  sourceW: number,
  sourceH: number,
  destX: number,
  destY: number,
  destW: number,
  destH: number,
  cam: RecordingCameraState,
  fit: RecordingCameraFit = "cover",
): RecordingCameraDrawRects | null {
  if (!sourceW || !sourceH || destW <= 0 || destH <= 0) return null;
  const scale = clamp(cam.scale, RECORDING_CAMERA_MIN_SCALE, RECORDING_CAMERA_MAX_SCALE);
  const sw = sourceW / scale;
  const sh = sourceH / scale;
  const sx = clamp(cam.focusX * sourceW - sw / 2, 0, sourceW - sw);
  const sy = clamp(cam.focusY * sourceH - sh / 2, 0, sourceH - sh);

  if (fit === "fill") {
    return { sx, sy, sw, sh, dx: destX, dy: destY, dw: destW, dh: destH };
  }

  const ir = sw / sh;
  const cr = destW / destH;
  let dw = destW;
  let dh = destH;
  if (fit === "contain") {
    // object-contain: full crop visible, letterbox/pillarbox as needed
    if (ir > cr) {
      dw = destW;
      dh = destW / ir;
    } else {
      dh = destH;
      dw = destH * ir;
    }
  } else if (ir > cr) {
    // object-cover: fill dest, crop overflow
    dh = destH;
    dw = destH * ir;
  } else {
    dw = destW;
    dh = destW / ir;
  }
  const dx = destX + (destW - dw) / 2;
  const dy = destY + (destH - dh) / 2;
  return { sx, sy, sw, sh, dx, dy, dw, dh };
}

/** Absolute layout for a <video> so it matches recordingCameraDrawRects (export parity). */
export function recordingCameraVideoLayout(
  sourceW: number,
  sourceH: number,
  rects: RecordingCameraDrawRects,
  fit: RecordingCameraFit = "cover",
): { left: number; top: number; width: number; height: number } {
  if (fit === "fill") {
    const scaleX = rects.dw / Math.max(1e-6, rects.sw);
    const scaleY = rects.dh / Math.max(1e-6, rects.sh);
    return {
      width: sourceW * scaleX,
      height: sourceH * scaleY,
      left: rects.dx - rects.sx * scaleX,
      top: rects.dy - rects.sy * scaleY,
    };
  }
  const scale = rects.dw / Math.max(1e-6, rects.sw);
  return {
    width: sourceW * scale,
    height: sourceH * scale,
    left: rects.dx - rects.sx * scale,
    top: rects.dy - rects.sy * scale,
  };
}

/** Map a source-normalized point into dest pixels for the current camera view. */
export function sourcePointToView(
  sourceX: number,
  sourceY: number,
  sourceW: number,
  sourceH: number,
  rects: RecordingCameraDrawRects,
): { left: number; top: number } | null {
  if (!sourceW || !sourceH || rects.sw <= 0 || rects.sh <= 0) return null;
  const px = sourceX * sourceW;
  const py = sourceY * sourceH;
  return {
    left: rects.dx + ((px - rects.sx) / rects.sw) * rects.dw,
    top: rects.dy + ((py - rects.sy) / rects.sh) * rects.dh,
  };
}

/** CSS for a cover-fitted video inside an overflow-hidden wrapper.
 * Prefer recordingCameraVideoLayout + draw-rects for preview/export parity.
 */
export function recordingCameraCssStyle(cam: RecordingCameraState): {
  transform: string;
  transformOrigin: string;
} {
  const scale = clamp(cam.scale, RECORDING_CAMERA_MIN_SCALE, RECORDING_CAMERA_MAX_SCALE);
  return {
    transform: scale <= 1.001 ? "none" : `scale(${scale})`,
    transformOrigin: `${cam.focusX * 100}% ${cam.focusY * 100}%`,
  };
}

/**
 * Place a zoom that finishes at `atMs` and lasts `durationMs`.
 * Inserts a from-keyframe at atMs-duration so the move isn't stretched across the whole timeline.
 */
export function applyRecordingCameraZoomAt(
  keyframes: RecordingCameraKeyframe[],
  atMs: number,
  patch: Partial<Pick<RecordingCameraKeyframe, "scale" | "focusX" | "focusY" | "easing">>,
  durationMs: number = DEFAULT_CAMERA_ZOOM_DURATION_MS,
): RecordingCameraKeyframe[] {
  const keys = normalizeRecordingCameraKeyframes(keyframes);
  const t = Math.max(0, Math.round(atMs));
  const dur = clampCameraZoomDurationMs(durationMs);
  const startMs = Math.max(0, t - dur);
  const before = recordingCameraAt(keys, Math.max(0, startMs - 1));
  const targetScale = clamp(
    patch.scale ?? before.scale,
    RECORDING_CAMERA_MIN_SCALE,
    RECORDING_CAMERA_MAX_SCALE,
  );
  const targetFocusX = clamp(patch.focusX ?? before.focusX, 0, 1);
  const targetFocusY = clamp(patch.focusY ?? before.focusY, 0, 1);
  const easing = patch.easing ?? "easeInOut";

  // Playhead at 0 (or move shorter than duration): upsert a single KF — never stack
  // two markers on top of each other at t=0 (that made the start look like 1.1×).
  if (t === 0 || startMs >= t) {
    const kept = keys.filter((k) => Math.abs(k.atMs - t) > 40);
    kept.push({
      atMs: t,
      scale: targetScale,
      focusX: targetFocusX,
      focusY: targetFocusY,
      easing,
    });
    if (t > 0 && !kept.some((k) => k.atMs <= 40)) {
      kept.unshift({ ...DEFAULT_RECORDING_CAMERA_KEYFRAME, easing: "easeInOut" });
    }
    return normalizeRecordingCameraKeyframes(kept);
  }

  const kept = keys.filter((k) => {
    if (Math.abs(k.atMs - startMs) <= 40) return false;
    if (Math.abs(k.atMs - t) <= 40) return false;
    if (k.atMs > startMs + 40 && k.atMs < t - 40) return false;
    return true;
  });

  kept.push({
    atMs: startMs,
    scale: before.scale,
    focusX: before.focusX,
    focusY: before.focusY,
    easing,
  });
  kept.push({
    atMs: t,
    scale: targetScale,
    focusX: targetFocusX,
    focusY: targetFocusY,
    easing,
  });
  return normalizeRecordingCameraKeyframes(kept);
}

/** Zoom transitions where scale actually changes (for SFX). */
export function recordingCameraZoomEvents(
  keyframes: RecordingCameraKeyframe[] | null | undefined,
): RecordingCameraZoomEvent[] {
  const keys = normalizeRecordingCameraKeyframes(keyframes);
  const events: RecordingCameraZoomEvent[] = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (Math.abs(b.scale - a.scale) < 0.05) continue;
    if (b.atMs - a.atMs < 40) continue;
    events.push({
      startMs: a.atMs,
      endMs: b.atMs,
      fromScale: a.scale,
      toScale: b.scale,
    });
  }
  return events;
}

export function upsertRecordingCameraKeyframe(
  keyframes: RecordingCameraKeyframe[],
  atMs: number,
  patch: Partial<Omit<RecordingCameraKeyframe, "atMs">>,
): RecordingCameraKeyframe[] {
  const keys = normalizeRecordingCameraKeyframes(keyframes);
  const t = Math.max(0, Math.round(atMs));
  const idx = keys.findIndex((k) => Math.abs(k.atMs - t) <= 40);
  const current = recordingCameraAt(keys, t);
  const next: RecordingCameraKeyframe = {
    atMs: t,
    scale: clamp(
      patch.scale ?? current.scale,
      RECORDING_CAMERA_MIN_SCALE,
      RECORDING_CAMERA_MAX_SCALE,
    ),
    focusX: clamp(patch.focusX ?? current.focusX, 0, 1),
    focusY: clamp(patch.focusY ?? current.focusY, 0, 1),
    easing: patch.easing ?? "easeInOut",
  };
  if (idx >= 0) {
    const copy = keys.slice();
    copy[idx] = { ...copy[idx]!, ...next, atMs: keys[idx]!.atMs };
    return normalizeRecordingCameraKeyframes(copy);
  }
  return normalizeRecordingCameraKeyframes([...keys, next]);
}

export function removeRecordingCameraKeyframe(
  keyframes: RecordingCameraKeyframe[],
  atMs: number,
): RecordingCameraKeyframe[] {
  const keys = normalizeRecordingCameraKeyframes(keyframes).filter(
    (k) => Math.abs(k.atMs - atMs) > 40,
  );
  return normalizeRecordingCameraKeyframes(keys);
}

export function moveRecordingCameraKeyframe(
  keyframes: RecordingCameraKeyframe[],
  fromAtMs: number,
  toAtMs: number,
): RecordingCameraKeyframe[] {
  const keys = normalizeRecordingCameraKeyframes(keyframes);
  const idx = keys.findIndex((k) => Math.abs(k.atMs - fromAtMs) <= 40);
  if (idx < 0) return keys;
  if (idx === 0) return keys;
  const copy = keys.slice();
  copy[idx] = { ...copy[idx]!, atMs: Math.max(0, Math.round(toAtMs)) };
  return normalizeRecordingCameraKeyframes(copy);
}
