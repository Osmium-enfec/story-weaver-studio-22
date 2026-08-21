import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  DEFAULT_PLACEMENT_SFX,
  PLACEMENT_SFX_OPTIONS,
  placementSfxKey,
  placementSfxUrl,
  type ComposeCrop,
  type ComposePlacement,
  type PlacementSfxKey,
} from "@/lib/compose-scene";

type DragKind = { type: "scrub" } | { type: "placement"; id: string };

interface AudioTimelineProps {
  audioUrl: string;
  durationMs: number;
  crops: ComposeCrop[];
  placements: ComposePlacement[];
  selectedCropId: string | null;
  onSelectCrop: (id: string | null) => void;
  onDuration: (ms: number) => void;
  onAddPlacement: (cropId: string, startMs: number, sfxUrl?: string | null) => void;
  onUpdatePlacement: (
    id: string,
    patch: { startMs?: number; sfxUrl?: string | null },
  ) => void;
  onRemovePlacement: (id: string) => void;
  onSeek: (ms: number) => void;
}

export function AudioTimeline({
  audioUrl,
  durationMs,
  crops,
  placements,
  selectedCropId,
  onSelectCrop,
  onDuration,
  onAddPlacement,
  onUpdatePlacement,
  onRemovePlacement,
  onSeek,
}: AudioTimelineProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragKind | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState<DragKind | null>(null);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onMeta = () => {
      if (a.duration && isFinite(a.duration)) {
        onDuration(Math.round(a.duration * 1000));
      }
    };
    const onTime = () => {
      if (dragRef.current?.type === "scrub") return;
      setCurrentMs(a.currentTime * 1000);
    };
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", () => setPlaying(false));
    return () => {
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("timeupdate", onTime);
    };
  }, [audioUrl, onDuration]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.play().catch(() => setPlaying(false));
    else a.pause();
  }, [playing]);

  const seekToMs = useCallback(
    (ms: number, opts?: { play?: boolean }) => {
      const dur = durationMs || 1;
      const clamped = Math.max(0, Math.min(dur, ms));
      setCurrentMs(clamped);
      onSeek(clamped);
      if (audioRef.current) audioRef.current.currentTime = clamped / 1000;
      if (opts?.play) setPlaying(true);
    },
    [durationMs, onSeek],
  );

  function clientXToMs(clientX: number): number {
    const bar = barRef.current;
    const dur = durationMs || 1;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return frac * dur;
  }

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const kind = dragRef.current;
      if (!kind) return;
      const ms = clientXToMs(e.clientX);
      if (kind.type === "scrub") {
        seekToMs(ms);
      } else {
        onUpdatePlacement(kind.id, { startMs: Math.round(ms) });
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bind while dragging
  }, [dragging, seekToMs, onUpdatePlacement]);

  function beginDrag(kind: DragKind, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = kind;
    setDragging(kind);
    if (kind.type === "scrub") {
      setPlaying(false);
      seekToMs(clientXToMs(e.clientX));
    } else {
      onUpdatePlacement(kind.id, { startMs: Math.round(clientXToMs(e.clientX)) });
    }
  }

  function seekFromBarClick(e: React.MouseEvent<HTMLDivElement>) {
    if (dragRef.current) return;
    seekToMs(clientXToMs(e.clientX));
  }

  function fmt(ms: number) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 100)).padStart(2, "0")}`;
  }

  function previewSfx(url: string) {
    const a = new Audio(url);
    a.volume = 0.85;
    void a.play().catch(() => {});
  }

  function addAtPlayhead() {
    if (!selectedCropId) return;
    onAddPlacement(selectedCropId, Math.round(currentMs), DEFAULT_PLACEMENT_SFX);
  }

  function addCropAtPlayhead(cropId: string) {
    onSelectCrop(cropId);
    onAddPlacement(cropId, Math.round(currentMs), DEFAULT_PLACEMENT_SFX);
  }

  const dur = durationMs || 1;
  const pct = (currentMs / dur) * 100;

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      {crops.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Layer elements — click to add at playhead, then drag on the timeline to move
          </p>
          <div className="flex flex-wrap gap-2">
            {crops.map((c) => {
              const selected = selectedCropId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => addCropAtPlayhead(c.id)}
                  onFocus={() => onSelectCrop(c.id)}
                  className={`group flex w-[72px] flex-col items-center rounded-lg border p-1.5 text-left transition hover:border-primary hover:bg-primary/5 ${
                    selected ? "border-primary ring-2 ring-primary/30" : "bg-background"
                  }`}
                  title={`Add "${c.name}" at ${fmt(currentMs)}`}
                >
                  <img
                    src={c.imageUrl}
                    alt=""
                    className="aspect-square w-full rounded border bg-white object-contain"
                  />
                  <span className="mt-1 w-full truncate text-center text-[10px] font-medium leading-tight">
                    {c.name}
                  </span>
                  <span className="text-[9px] text-muted-foreground opacity-0 group-hover:opacity-100">
                    + at playhead
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span className="tabular-nums text-sm text-muted-foreground">
          {fmt(currentMs)} / {fmt(dur)}
        </span>
        <button
          type="button"
          disabled={!selectedCropId}
          onClick={addAtPlayhead}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          <Plus size={14} /> Add selected at playhead
        </button>
      </div>

      <div
        ref={barRef}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={dur}
        aria-valuenow={Math.round(currentMs)}
        className="relative h-14 cursor-pointer rounded-md bg-muted"
        onClick={seekFromBarClick}
      >
        {placements.map((p) => {
          const crop = crops.find((c) => c.id === p.cropId);
          const left = (p.startMs / dur) * 100;
          const sfxLabel = PLACEMENT_SFX_OPTIONS.find(
            (o) => o.id === placementSfxKey(p.sfxUrl),
          )?.label;
          const isDrag = dragging?.type === "placement" && dragging.id === p.id;
          return (
            <div
              key={p.id}
              className={`absolute top-1 z-20 flex -translate-x-1/2 cursor-grab flex-col items-center active:cursor-grabbing ${
                isDrag ? "z-40 opacity-90" : ""
              }`}
              style={{ left: `${left}%` }}
              title={`Drag to move · ${crop?.name ?? "crop"} @ ${fmt(p.startMs)}${sfxLabel ? ` · ${sfxLabel}` : ""}`}
              onPointerDown={(e) => beginDrag({ type: "placement", id: p.id }, e)}
              onClick={(e) => e.stopPropagation()}
            >
              {crop?.imageUrl ? (
                <img
                  src={crop.imageUrl}
                  alt=""
                  draggable={false}
                  className="h-8 w-8 rounded border-2 border-primary/50 bg-white object-contain shadow-sm pointer-events-none"
                />
              ) : (
                <div className="h-8 w-8 rounded border bg-background pointer-events-none" />
              )}
              <div className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary pointer-events-none" />
            </div>
          );
        })}

        {/* Draggable playhead */}
        <div
          className="absolute top-0 z-30 cursor-ew-resize"
          style={{
            left: `${pct}%`,
            height: "100%",
            width: 16,
            transform: "translateX(-50%)",
          }}
          onPointerDown={(e) => beginDrag({ type: "scrub" }, e)}
          onClick={(e) => e.stopPropagation()}
          title="Drag to scrub — Play continues from here"
        >
          <div className="mx-auto h-2.5 w-2.5 rounded-full bg-foreground shadow" />
          <div className="mx-auto h-[calc(100%-10px)] w-0.5 bg-foreground" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Drag the black playhead to scrub, then Play from that spot. Drag layer thumbs on the bar to
        reposition. Click the bar to jump.
      </p>

      {placements.length > 0 && (
        <ul className="max-h-48 space-y-1.5 overflow-y-auto text-sm">
          {[...placements]
            .sort((a, b) => a.startMs - b.startMs)
            .map((p) => {
              const crop = crops.find((c) => c.id === p.cropId);
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded border px-2 py-1.5"
                >
                  {crop?.imageUrl ? (
                    <img
                      src={crop.imageUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded border bg-white object-contain"
                    />
                  ) : (
                    <div className="h-10 w-10 shrink-0 rounded border bg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{crop?.name ?? "?"}</p>
                    <label className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      @
                      <input
                        type="number"
                        min={0}
                        max={Math.round(dur)}
                        step={100}
                        value={Math.round(p.startMs)}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isFinite(v)) return;
                          onUpdatePlacement(p.id, {
                            startMs: Math.max(0, Math.min(dur, Math.round(v))),
                          });
                        }}
                        className="w-20 rounded border bg-background px-1 py-0.5 tabular-nums"
                        aria-label="Start time ms"
                      />
                      ms
                    </label>
                  </div>
                  <select
                    value={placementSfxKey(p.sfxUrl)}
                    onChange={(e) => {
                      const key = e.target.value as PlacementSfxKey;
                      const url = placementSfxUrl(key);
                      onUpdatePlacement(p.id, { sfxUrl: url });
                      if (url) previewSfx(url);
                    }}
                    className="max-w-[7.5rem] shrink-0 rounded-md border bg-background px-1.5 py-1 text-xs"
                    aria-label="Reveal sound"
                  >
                    {PLACEMENT_SFX_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => onRemovePlacement(p.id)}
                    className="rounded p-1.5 hover:bg-destructive/10 hover:text-destructive"
                    aria-label="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
        </ul>
      )}

      <audio ref={audioRef} src={audioUrl} preload="auto" />
    </div>
  );
}
