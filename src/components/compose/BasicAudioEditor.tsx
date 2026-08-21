import { useEffect, useMemo, useRef, useState } from "react";
import { encodeWav } from "@/lib/audio-slice";
import { createClientId } from "@/lib/client-id";

interface AudioClipDraft {
  id: string;
  sourceStartMs: number;
  sourceEndMs: number;
  timelineStartMs: number;
}

interface BasicAudioEditorProps {
  audioUrl: string;
  disabled?: boolean;
  onApply: (url: string) => void;
}

interface AudioEditorSnapshot {
  clips: AudioClipDraft[];
  cutStartMs: number;
  cutEndMs: number;
}

type DragState =
  | { type: "playhead" }
  | { type: "clip"; id: string; offsetMs: number }
  | { type: "trim-start"; id: string }
  | { type: "trim-end"; id: string }
  | { type: "cut-start" }
  | { type: "cut-end" };

function fmtMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function clipDurationMs(clip: AudioClipDraft): number {
  return Math.max(0, clip.sourceEndMs - clip.sourceStartMs);
}

function clipEndMs(clip: AudioClipDraft): number {
  return clip.timelineStartMs + clipDurationMs(clip);
}

function newClip(
  sourceStartMs: number,
  sourceEndMs: number,
  timelineStartMs: number,
): AudioClipDraft {
  return {
    id: createClientId(),
    sourceStartMs,
    sourceEndMs,
    timelineStartMs,
  };
}

export function BasicAudioEditor({
  audioUrl,
  disabled = false,
  onApply,
}: BasicAudioEditorProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const playStartedAtRef = useRef(0);
  const playStartedMsRef = useRef(0);
  const [durationMs, setDurationMs] = useState(0);
  const [currentMs, setCurrentMs] = useState(0);
  const [clips, setClips] = useState<AudioClipDraft[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [cutStartMs, setCutStartMs] = useState(0);
  const [cutEndMs, setCutEndMs] = useState(0);
  const [regionMode, setRegionMode] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [history, setHistory] = useState<AudioEditorSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDurationMs(0);
    setCurrentMs(0);
    setClips([]);
    setSelectedClipId(null);
    setEditorOpen(false);
    setPlaying(false);
    setCutStartMs(0);
    setCutEndMs(0);
    setRegionMode(false);
    setHistory([]);
    setError(null);
  }, [audioUrl]);

  const selectedIdx = useMemo(
    () => clips.findIndex((s) => s.id === selectedClipId),
    [clips, selectedClipId],
  );
  const selected = selectedIdx >= 0 ? clips[selectedIdx] : null;
  const sortedClips = useMemo(
    () => [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs),
    [clips],
  );
  const timelineDurationMs = useMemo(() => {
    const clipsEnd = clips.reduce((max, clip) => Math.max(max, clipEndMs(clip)), 0);
    return Math.max(durationMs, clipsEnd, cutStartMs, cutEndMs, 1000);
  }, [clips, cutEndMs, cutStartMs, durationMs]);

  const outputDurationMs = useMemo(() => {
    return clips.reduce((max, clip) => Math.max(max, clipEndMs(clip)), 0);
  }, [clips]);

  const activeRegionClip = selected ?? sortedClips[0] ?? null;

  function regionBounds() {
    if (!activeRegionClip) {
      return { startMs: 0, endMs: timelineDurationMs };
    }
    return {
      startMs: activeRegionClip.timelineStartMs,
      endMs: clipEndMs(activeRegionClip),
    };
  }

  function snapMs(ms: number, anchors: number[], thresholdMs = 120): number {
    let best = ms;
    let bestDistance = thresholdMs + 1;
    for (const anchor of anchors) {
      const distance = Math.abs(anchor - ms);
      if (distance <= thresholdMs && distance < bestDistance) {
        best = anchor;
        bestDistance = distance;
      }
    }
    return best;
  }

  function timelineToSourceMs(ms: number): number | null {
    const clip = sortedClips.find((item) => ms >= item.timelineStartMs && ms <= clipEndMs(item));
    if (!clip) return null;
    return clip.sourceStartMs + (ms - clip.timelineStartMs);
  }

  function stopPreviewPlayback() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.muted = false;
    }
    setPlaying(false);
  }

  function pushHistory() {
    setHistory((prev) => [
      ...prev,
      {
        clips: clips.map((clip) => ({ ...clip })),
        cutStartMs,
        cutEndMs,
      },
    ]);
  }

  function undoLast() {
    setHistory((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      setClips(last.clips);
      setSelectedClipId(last.clips[0]?.id ?? null);
      setCutStartMs(last.cutStartMs);
      setCutEndMs(last.cutEndMs);
      setRegionMode(false);
      setError(null);
      return prev.slice(0, -1);
    });
  }

  useEffect(() => {
    if (!editorOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undoLast();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editorOpen, history]);

  useEffect(() => {
    const maxPlayableMs = Math.max(0, outputDurationMs);
    if (currentMs > maxPlayableMs) {
      setCurrentMs(maxPlayableMs);
      syncAudioCurrent(maxPlayableMs);
    }
  }, [currentMs, outputDurationMs]);

  useEffect(() => {
    if (!regionMode || !activeRegionClip) return;
    const bounds = regionBounds();
    setCutStartMs((prev) => clamp(prev, bounds.startMs, bounds.endMs));
    setCutEndMs((prev) => clamp(prev, bounds.startMs, bounds.endMs));
  }, [regionMode, activeRegionClip, timelineDurationMs]);

  useEffect(() => {
    return () => stopPreviewPlayback();
  }, []);

  function syncAudioCurrent(ms: number) {
    const audio = audioRef.current;
    if (!audio) return;
    const sourceMs = timelineToSourceMs(ms);
    if (sourceMs == null) {
      audio.pause();
      audio.muted = true;
      return;
    }
    audio.muted = false;
    if (Math.abs(audio.currentTime * 1000 - sourceMs) > 40) {
      audio.currentTime = Math.max(0, sourceMs) / 1000;
    }
  }

  async function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      stopPreviewPlayback();
      return;
    }
    try {
      playStartedAtRef.current = performance.now();
      playStartedMsRef.current = currentMs;
      setPlaying(true);
      const step = async () => {
        const nextMs = playStartedMsRef.current + (performance.now() - playStartedAtRef.current);
        if (nextMs >= outputDurationMs) {
          setCurrentMs(outputDurationMs);
          syncAudioCurrent(outputDurationMs);
          stopPreviewPlayback();
          return;
        }
        setCurrentMs(nextMs);
        syncAudioCurrent(nextMs);
        const sourceMs = timelineToSourceMs(nextMs);
        if (sourceMs != null && audio.paused) {
          await audio.play().catch(() => undefined);
        }
        rafRef.current = requestAnimationFrame(() => {
          void step();
        });
      };
      syncAudioCurrent(currentMs);
      const sourceMs = timelineToSourceMs(currentMs);
      if (sourceMs != null) {
        await audio.play();
      }
      setPlaying(true);
      rafRef.current = requestAnimationFrame(() => {
        void step();
      });
    } catch {
      stopPreviewPlayback();
    }
  }

  function updateSelectedBoundary(kind: "start" | "end", nextTimelineMs: number) {
    if (!selected || selectedIdx < 0) return;
    setClips((cur) =>
      cur.map((clip, idx) => {
        if (idx !== selectedIdx) return clip;
        if (kind === "start") {
          const maxTimelineStart = clipEndMs(clip) - 200;
          const timelineStartMs = clamp(nextTimelineMs, 0, maxTimelineStart);
          const delta = timelineStartMs - clip.timelineStartMs;
          return {
            ...clip,
            timelineStartMs,
            sourceStartMs: clamp(
              clip.sourceStartMs + delta,
              0,
              clip.sourceEndMs - 200,
            ),
          };
        }
        const nextEnd = clamp(nextTimelineMs, clip.timelineStartMs + 200, timelineDurationMs);
        return {
          ...clip,
          sourceEndMs: clamp(
            clip.sourceStartMs + (nextEnd - clip.timelineStartMs),
            clip.sourceStartMs + 200,
            durationMs,
          ),
        };
      }),
    );
  }

  function splitAtPlayhead() {
    if (!selected || selectedIdx < 0) return;
    const splitMs = Math.round(currentMs);
    if (splitMs <= selected.timelineStartMs + 200 || splitMs >= clipEndMs(selected) - 200) {
      setError("Move the playhead inside the selected clip before splitting.");
      return;
    }
    setError(null);
    pushHistory();
    const offsetIntoSource = splitMs - selected.timelineStartMs;
    const splitSourceMs = selected.sourceStartMs + offsetIntoSource;
    const left = newClip(selected.sourceStartMs, splitSourceMs, selected.timelineStartMs);
    const right = newClip(splitSourceMs, selected.sourceEndMs, splitMs);
    const next = [...clips];
    next.splice(selectedIdx, 1, left, right);
    setClips(next);
    setSelectedClipId(right.id);
  }

  function deleteSelectedClip() {
    if (!selected || clips.length <= 1) return;
    pushHistory();
    const next = clips.filter((s) => s.id !== selected.id);
    setClips(next);
    setSelectedClipId(next[Math.max(0, selectedIdx - 1)]?.id ?? next[0]?.id ?? null);
    setError(null);
  }

  function cutSelectedRegion() {
    const startMs = Math.min(cutStartMs, cutEndMs);
    const endMs = Math.max(cutStartMs, cutEndMs);
    if (endMs - startMs < 100) {
      setError("Move the two red cut lines apart before cutting.");
      return;
    }
    pushHistory();
    const next: AudioClipDraft[] = [];
    for (const clip of clips) {
      const start = clip.timelineStartMs;
      const end = clipEndMs(clip);
      if (endMs <= start || startMs >= end) {
        next.push(clip);
        continue;
      }
      if (startMs > start) {
        const leftDur = startMs - start;
        next.push(newClip(clip.sourceStartMs, clip.sourceStartMs + leftDur, clip.timelineStartMs));
      }
      if (endMs < end) {
        const cutOffset = endMs - start;
        next.push(newClip(clip.sourceStartMs + cutOffset, clip.sourceEndMs, endMs));
      }
    }
    if (!next.length) {
      setError("That cut would remove the whole audio.");
      return;
    }
    setClips(next);
    setSelectedClipId(next[0]?.id ?? null);
    setRegionMode(false);
    setError(null);
  }

  function clientXToTimelineMs(clientX: number): number {
    const el = timelineRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    return frac * timelineDurationMs;
  }

  function timelineAnchors(excludeClipId?: string): number[] {
    const anchors = [0, outputDurationMs, currentMs];
    for (const clip of sortedClips) {
      if (clip.id === excludeClipId) continue;
      anchors.push(clip.timelineStartMs, clipEndMs(clip));
    }
    if (regionMode) {
      anchors.push(cutStartMs, cutEndMs);
      const bounds = regionBounds();
      anchors.push(bounds.startMs, bounds.endMs);
    }
    return anchors;
  }

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const rawMs = Math.round(clientXToTimelineMs(e.clientX));
      if (drag.type === "playhead") {
        const ms = clamp(snapMs(rawMs, timelineAnchors()), 0, outputDurationMs);
        setCurrentMs(ms);
        syncAudioCurrent(ms);
        return;
      }
      if (drag.type === "cut-start") {
        const bounds = regionBounds();
        const ms = snapMs(rawMs, [bounds.startMs, bounds.endMs, cutEndMs, ...timelineAnchors()]);
        setCutStartMs(clamp(ms, bounds.startMs, bounds.endMs));
        return;
      }
      if (drag.type === "cut-end") {
        const bounds = regionBounds();
        const ms = snapMs(rawMs, [bounds.startMs, bounds.endMs, cutStartMs, ...timelineAnchors()]);
        setCutEndMs(clamp(ms, bounds.startMs, bounds.endMs));
        return;
      }
      if (drag.type === "clip") {
        setClips((cur) =>
          cur.map((clip) =>
            clip.id === drag.id
              ? {
                  ...clip,
                  timelineStartMs: clamp(
                    snapMs(rawMs - drag.offsetMs, timelineAnchors(clip.id)),
                    0,
                    Math.max(0, timelineDurationMs - clipDurationMs(clip)),
                  ),
                }
              : clip,
          ),
        );
        return;
      }
      if (drag.type === "trim-start") {
        updateSelectedBoundary("start", snapMs(rawMs, timelineAnchors(selected?.id ?? undefined)));
        return;
      }
      if (drag.type === "trim-end") {
        updateSelectedBoundary("end", snapMs(rawMs, timelineAnchors(selected?.id ?? undefined)));
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, timelineDurationMs, selected, selectedIdx, clips, durationMs]);

  async function applyEdits() {
    if (!clips.length) return;
    setBusy(true);
    setError(null);
    const AC =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) {
      setBusy(false);
      setError("Web Audio is not available in this browser.");
      return;
    }
    const ctx = new AC();
    try {
      const res = await fetch(audioUrl);
      if (!res.ok) throw new Error(`Could not load audio (${res.status}).`);
      const ab = await res.arrayBuffer();
      const full = await ctx.decodeAudioData(ab.slice(0));
      const sampleRate = full.sampleRate;
      const ordered = [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
      const outLength = ordered.reduce(
        (max, clip) =>
          Math.max(max, Math.ceil((clipEndMs(clip) / 1000) * sampleRate)),
        1,
      );
      const out = ctx.createBuffer(full.numberOfChannels, outLength, sampleRate);
      for (const clip of ordered) {
        const srcStart = Math.max(0, Math.floor((clip.sourceStartMs / 1000) * sampleRate));
        const srcEnd = Math.min(full.length, Math.ceil((clip.sourceEndMs / 1000) * sampleRate));
        const len = Math.max(1, srcEnd - srcStart);
        const dstStart = Math.max(0, Math.floor((clip.timelineStartMs / 1000) * sampleRate));
        for (let ch = 0; ch < full.numberOfChannels; ch++) {
          const src = full.getChannelData(ch);
          const dst = out.getChannelData(ch);
          for (let i = 0; i < len && dstStart + i < dst.length; i++) {
            dst[dstStart + i] = (dst[dstStart + i] ?? 0) + (src[srcStart + i] ?? 0);
          }
        }
      }
      const wav = encodeWav(out);
      const blobUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      onApply(blobUrl);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not edit audio.");
    } finally {
      await ctx.close().catch(() => {});
      setBusy(false);
    }
  }

  return (
    <>
      <audio
        ref={audioRef}
        src={audioUrl}
        className="hidden"
        onLoadedMetadata={(e) => {
          const ms = Math.round((e.currentTarget.duration || 0) * 1000);
          const first = ms > 0 ? newClip(0, ms, 0) : null;
          setDurationMs(ms);
          setClips(first ? [first] : []);
          setSelectedClipId(first?.id ?? null);
          setCutStartMs(ms > 0 ? Math.round(ms * 0.2) : 0);
          setCutEndMs(ms > 0 ? Math.round(ms * 0.4) : 0);
          setCurrentMs(0);
        }}
        onEnded={() => stopPreviewPlayback()}
        onPause={() => {
          if (playing && rafRef.current === null) {
            setPlaying(false);
          }
        }}
      />

      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Audio editor</p>
            <p className="text-xs text-muted-foreground">
              Opens only when needed. Drag clips and handles directly on the timeline.
            </p>
          </div>
          <button
            type="button"
            disabled={disabled || durationMs <= 0}
            onClick={() => setEditorOpen((v) => !v)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            {editorOpen ? "Close editor" : "Edit audio"}
          </button>
        </div>
      </div>

      {editorOpen && durationMs > 0 && (
        <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={disabled || busy}
              onClick={togglePlay}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {playing ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              disabled={disabled || busy || !selected}
              onClick={splitAtPlayhead}
              className="rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              Split at playhead
            </button>
            <button
              type="button"
              disabled={disabled || busy || !selected || clips.length <= 1}
              onClick={deleteSelectedClip}
              className="rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              Delete selected clip
            </button>
            <button
              type="button"
              disabled={disabled || busy || (regionMode && Math.abs(cutEndMs - cutStartMs) < 100)}
              onClick={() => {
                if (!regionMode) {
                  const bounds = regionBounds();
                  const span = Math.max(200, bounds.endMs - bounds.startMs);
                  setCutStartMs(bounds.startMs + Math.round(span * 0.25));
                  setCutEndMs(bounds.startMs + Math.round(span * 0.75));
                  setRegionMode(true);
                  setError(null);
                  return;
                }
                cutSelectedRegion();
              }}
              className="rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              {regionMode ? "Cut selected region" : "Select region to cut"}
            </button>
            <button
              type="button"
              disabled={disabled || busy || !clips.length}
              onClick={applyEdits}
              className="ml-auto rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save edited audio"}
            </button>
          </div>

          <div className="rounded-xl border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>Timeline</span>
              <span>
                Playhead {fmtMs(currentMs)} / {fmtMs(outputDurationMs || timelineDurationMs)}
              </span>
            </div>

            <div
              ref={timelineRef}
              className="relative h-32 overflow-hidden rounded-lg border bg-white"
              onClick={(e) => {
                if (drag) return;
                const ms = clamp(Math.round(clientXToTimelineMs(e.clientX)), 0, outputDurationMs);
                setCurrentMs(ms);
                syncAudioCurrent(ms);
              }}
            >
              <div
                className="absolute inset-0 opacity-70"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(90deg, rgba(15,23,42,0.06) 0 2px, transparent 2px 10px)",
                }}
              />

              {sortedClips.map((clip, idx) => {
                const left = `${(clip.timelineStartMs / timelineDurationMs) * 100}%`;
                const width = `${(clipDurationMs(clip) / timelineDurationMs) * 100}%`;
                const selectedNow = clip.id === selectedClipId;
                return (
                  <div
                    key={clip.id}
                    className={`absolute bottom-6 top-10 rounded-md border ${
                      selectedNow
                        ? "border-primary bg-primary/15 shadow-sm"
                        : "border-orange-300 bg-orange-100"
                    }`}
                    style={{ left, width }}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedClipId(clip.id)}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        const ms = clientXToTimelineMs(e.clientX);
                        setSelectedClipId(clip.id);
                        pushHistory();
                        setDrag({
                          type: "clip",
                          id: clip.id,
                          offsetMs: ms - clip.timelineStartMs,
                        });
                      }}
                      className="h-full w-full px-3 py-2 text-left"
                      title="Drag this block to move it. Gaps stay silent."
                    >
                      <div className="flex h-full items-end justify-between text-xs">
                        <span className="font-medium">Clip {idx + 1}</span>
                        <span>{fmtMs(clipDurationMs(clip))}</span>
                      </div>
                    </button>
                    <div
                      className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md border-r bg-white/70"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelectedClipId(clip.id);
                        pushHistory();
                        setDrag({ type: "trim-start", id: clip.id });
                      }}
                      title="Trim from start"
                    />
                    <div
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md border-l bg-white/70"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelectedClipId(clip.id);
                        pushHistory();
                        setDrag({ type: "trim-end", id: clip.id });
                      }}
                      title="Trim from end"
                    />
                  </div>
                );
              })}

              <div
                className="absolute inset-y-0 z-20 w-0.5 cursor-ew-resize bg-sky-500"
                style={{ left: `${(currentMs / timelineDurationMs) * 100}%` }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setDrag({ type: "playhead" });
                }}
                title="Playhead"
              >
                <div className="-ml-2 h-3 w-4 rounded-b bg-sky-500" />
              </div>

              {regionMode && (
                <>
                  <div
                    className="absolute inset-y-0 z-10 w-0.5 cursor-ew-resize bg-red-500"
                    style={{ left: `${(cutStartMs / timelineDurationMs) * 100}%` }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      pushHistory();
                      setDrag({ type: "cut-start" });
                    }}
                    title="Cut start"
                  >
                    <div className="-ml-2 h-3 w-4 rounded-b bg-red-500" />
                  </div>
                  <div
                    className="absolute inset-y-0 z-10 w-0.5 cursor-ew-resize bg-red-500"
                    style={{ left: `${(cutEndMs / timelineDurationMs) * 100}%` }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      pushHistory();
                      setDrag({ type: "cut-end" });
                    }}
                    title="Cut end"
                  >
                    <div className="-ml-2 h-3 w-4 rounded-b bg-red-500" />
                  </div>
                </>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>Blue = playhead</span>
              <span>{regionMode ? "Red = cut range" : "Click select region to show cut markers"}</span>
              <span>Drag blocks to leave silence gaps</span>
            </div>
          </div>

          {selected && (
            <div className="rounded-lg border bg-muted/20 p-3 text-sm">
              <div className="font-medium">Selected clip</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Timeline: {fmtMs(selected.timelineStartMs)} to {fmtMs(clipEndMs(selected))}
              </div>
              <div className="text-xs text-muted-foreground">
                Source: {fmtMs(selected.sourceStartMs)} to {fmtMs(selected.sourceEndMs)}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Canvas stays fixed; clips move inward instead of stretching the timeline.</span>
            <button
              type="button"
              disabled={history.length === 0}
              onClick={undoLast}
              className="rounded border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
              title="Undo (Cmd/Ctrl+Z)"
            >
              Undo
            </button>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </>
  );
}
