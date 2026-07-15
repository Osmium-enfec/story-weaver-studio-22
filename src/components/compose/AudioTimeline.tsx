import { useEffect, useRef, useState } from "react";
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

interface AudioTimelineProps {
  audioUrl: string;
  durationMs: number;
  crops: ComposeCrop[];
  placements: ComposePlacement[];
  selectedCropId: string | null;
  onSelectCrop: (id: string | null) => void;
  onDuration: (ms: number) => void;
  onAddPlacement: (cropId: string, startMs: number, sfxUrl?: string | null) => void;
  onUpdatePlacement: (id: string, patch: { sfxUrl?: string | null }) => void;
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
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onMeta = () => {
      if (a.duration && isFinite(a.duration)) {
        onDuration(Math.round(a.duration * 1000));
      }
    };
    const onTime = () => setCurrentMs(a.currentTime * 1000);
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

  function seekFromEvent(e: React.MouseEvent<HTMLDivElement>) {
    const bar = barRef.current;
    if (!bar || durationMs <= 0) return;
    const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ms = frac * durationMs;
    setCurrentMs(ms);
    onSeek(ms);
    if (audioRef.current) audioRef.current.currentTime = ms / 1000;
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
            Cropped elements — click to add at playhead
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
        className="relative h-12 cursor-pointer rounded-md bg-muted"
        onClick={seekFromEvent}
      >
        {placements.map((p) => {
          const crop = crops.find((c) => c.id === p.cropId);
          const left = (p.startMs / dur) * 100;
          const sfxLabel = PLACEMENT_SFX_OPTIONS.find((o) => o.id === placementSfxKey(p.sfxUrl))?.label;
          return (
            <div
              key={p.id}
              className="absolute top-1 bottom-1 flex -translate-x-1/2 flex-col items-center"
              style={{ left: `${left}%` }}
              title={`${crop?.name ?? "crop"} @ ${fmt(p.startMs)}${sfxLabel ? ` · ${sfxLabel}` : ""}`}
            >
              {crop?.imageUrl ? (
                <img
                  src={crop.imageUrl}
                  alt=""
                  className="h-7 w-7 rounded border border-primary/40 bg-white object-contain shadow-sm"
                />
              ) : (
                <div className="h-7 w-7 rounded border bg-background" />
              )}
              <div className="mt-0.5 h-0.5 w-0.5 rounded-full bg-primary" />
            </div>
          );
        })}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-foreground"
          style={{ left: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Click the timeline to seek, then click a crop to place it. Pick tick, pop, or no sound on
        each element card below.
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
                    <p className="tabular-nums text-xs text-muted-foreground">@{fmt(p.startMs)}</p>
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
