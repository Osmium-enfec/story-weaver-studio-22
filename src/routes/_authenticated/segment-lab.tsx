import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TEMPLATES,
  getTemplate,
  type MaskTemplate,
  type RevealAnimation,
  type TemplateRegion,
} from "@/lib/mask-templates";
import { computeMaskStyle, totalDuration, type TimelineItem } from "@/lib/mask-reveal";
import { generateMcqImage } from "@/lib/mcq-image.functions";
import { useServerFn } from "@tanstack/react-start";

export const Route = createFileRoute("/_authenticated/segment-lab")({
  ssr: false,
  head: () => ({ meta: [{ title: "Segment Lab · Mask Reveal Studio" }] }),
  component: SegmentLab,
});

const STORAGE_KEY = "segment-lab:scene:v1";

interface SceneState {
  templateId: string;
  regions: TemplateRegion[]; // may be overridden from template defaults
  timeline: TimelineItem[];
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function buildDefaultScene(tpl: MaskTemplate): SceneState {
  const regions = tpl.regions.map((r) => ({ ...r }));
  const timeline: TimelineItem[] = regions.map((r, i) => ({
    regionId: r.id,
    startMs: i * 600,
    durationMs: r.defaultDurationMs ?? 400,
    animation: r.defaultAnim ?? "fade",
    ease: "ease-out",
  }));
  return { templateId: tpl.id, regions, timeline };
}

function SegmentLab() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [scene, setScene] = useState<SceneState>(() => buildDefaultScene(TEMPLATES[0]));
  const [selectedId, setSelectedId] = useState<string | null>(scene.regions[0]?.id ?? null);
  const [showOutlines, setShowOutlines] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);

  // Load persisted scene on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { scene: SceneState; image?: string };
        if (parsed.scene) setScene(parsed.scene);
        if (parsed.image) setImageDataUrl(parsed.image);
      }
    } catch {}
  }, []);

  // Persist
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ scene, image: imageDataUrl }));
    } catch {}
  }, [scene, imageDataUrl]);

  const template = getTemplate(scene.templateId);
  const duration = useMemo(() => totalDuration(scene.timeline), [scene.timeline]);

  // Playback loop
  useEffect(() => {
    if (!playing) return;
    startRef.current = performance.now() - offsetRef.current;
    const tick = () => {
      const t = performance.now() - startRef.current;
      if (t >= duration) {
        setTimeMs(duration);
        offsetRef.current = 0;
        setPlaying(false);
        return;
      }
      setTimeMs(t);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      offsetRef.current = performance.now() - startRef.current;
    };
  }, [playing, duration]);

  const onPickFile = useCallback(async (f: File | null) => {
    if (!f) return;
    const url = await fileToDataUrl(f);
    setImageDataUrl(url);
  }, []);

  const changeTemplate = (id: string) => {
    const tpl = getTemplate(id);
    const next = buildDefaultScene(tpl);
    setScene(next);
    setSelectedId(next.regions[0]?.id ?? null);
    setTimeMs(0);
    offsetRef.current = 0;
  };

  const selectedRegion = scene.regions.find((r) => r.id === selectedId) ?? null;
  const selectedTimeline = scene.timeline.find((t) => t.regionId === selectedId) ?? null;

  const updateRegion = (id: string, patch: Partial<TemplateRegion>) => {
    setScene((s) => ({ ...s, regions: s.regions.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  };
  const updateTimeline = (id: string, patch: Partial<TimelineItem>) => {
    setScene((s) => ({ ...s, timeline: s.timeline.map((t) => (t.regionId === id ? { ...t, ...patch } : t)) }));
  };
  const moveTimeline = (id: string, dir: -1 | 1) => {
    setScene((s) => {
      const idx = s.timeline.findIndex((t) => t.regionId === id);
      if (idx < 0) return s;
      const swap = idx + dir;
      if (swap < 0 || swap >= s.timeline.length) return s;
      const arr = [...s.timeline];
      [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
      // Re-space start times to preserve visual order after swap
      let cursor = arr[0].startMs;
      for (let i = 0; i < arr.length; i++) {
        arr[i] = { ...arr[i], startMs: cursor };
        cursor += arr[i].durationMs + 200;
      }
      return { ...s, timeline: arr };
    });
  };

  const play = () => {
    if (timeMs >= duration) {
      offsetRef.current = 0;
      setTimeMs(0);
    }
    setPlaying(true);
  };
  const pause = () => setPlaying(false);
  const restart = () => {
    setPlaying(false);
    offsetRef.current = 0;
    setTimeMs(0);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scene.templateId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-slate-50">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b bg-white px-4 py-2">
        <h1 className="text-lg font-semibold">Segment Lab</h1>
        <span className="text-xs text-slate-500">Mask Reveal Studio</span>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={scene.templateId}
            onChange={(e) => changeTemplate(e.target.value)}
            className="rounded-md border px-2 py-1 text-sm"
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} />
            outlines
          </label>
          <button onClick={exportJson} className="rounded-md border bg-white px-3 py-1 text-sm hover:bg-slate-50">
            Export JSON
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left panel */}
        <aside className="flex w-56 flex-col gap-1 overflow-y-auto border-r bg-white p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Reveal order
          </div>
          {scene.timeline.map((t, i) => {
            const region = scene.regions.find((r) => r.id === t.regionId);
            if (!region) return null;
            const active = selectedId === region.id;
            return (
              <div
                key={t.regionId}
                onClick={() => setSelectedId(region.id)}
                className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${
                  active ? "border-slate-900 bg-slate-100" : "border-transparent hover:bg-slate-50"
                }`}
              >
                <span className="w-5 font-mono text-xs text-slate-400">{i + 1}</span>
                <span className="flex-1 truncate">{region.label}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); moveTimeline(region.id, -1); }}
                  className="opacity-0 group-hover:opacity-100 text-xs text-slate-500 hover:text-slate-900"
                >↑</button>
                <button
                  onClick={(e) => { e.stopPropagation(); moveTimeline(region.id, 1); }}
                  className="opacity-0 group-hover:opacity-100 text-xs text-slate-500 hover:text-slate-900"
                >↓</button>
              </div>
            );
          })}
        </aside>

        {/* Center canvas */}
        <main className="flex flex-1 items-center justify-center overflow-auto p-6">
          {!imageDataUrl ? (
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onPickFile(e.dataTransfer.files?.[0] ?? null); }}
              className="flex h-96 w-full max-w-3xl cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-white text-sm text-slate-500 hover:bg-slate-50"
            >
              Click or drop an image (any 16:9-ish PNG)
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
              />
            </div>
          ) : (
            <CanvasStage
              imageUrl={imageDataUrl}
              template={template}
              scene={scene}
              timeMs={timeMs}
              selectedId={selectedId}
              showOutlines={showOutlines}
              onSelect={setSelectedId}
            />
          )}
        </main>

        {/* Right panel */}
        <aside className="w-72 overflow-y-auto border-l bg-white p-3">
          {selectedRegion && selectedTimeline ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Region</div>
                <div className="mt-1 rounded-md bg-slate-100 px-2 py-1 font-mono text-xs">{selectedRegion.id}</div>
              </div>
              <NumRow label="X (%)" value={selectedRegion.x * 100} onChange={(v) => updateRegion(selectedRegion.id, { x: v / 100 })} />
              <NumRow label="Y (%)" value={selectedRegion.y * 100} onChange={(v) => updateRegion(selectedRegion.id, { y: v / 100 })} />
              <NumRow label="W (%)" value={selectedRegion.w * 100} onChange={(v) => updateRegion(selectedRegion.id, { w: v / 100 })} />
              <NumRow label="H (%)" value={selectedRegion.h * 100} onChange={(v) => updateRegion(selectedRegion.id, { h: v / 100 })} />
              <NumRow label="Pad X (%)" value={(selectedRegion.padX ?? 0) * 100} onChange={(v) => updateRegion(selectedRegion.id, { padX: v / 100 })} />
              <NumRow label="Pad Y (%)" value={(selectedRegion.padY ?? 0) * 100} onChange={(v) => updateRegion(selectedRegion.id, { padY: v / 100 })} />

              <hr className="my-2" />
              <div>
                <label className="text-xs text-slate-500">Animation</label>
                <select
                  value={selectedTimeline.animation}
                  onChange={(e) => updateTimeline(selectedTimeline.regionId, { animation: e.target.value as RevealAnimation })}
                  className="mt-1 w-full rounded-md border px-2 py-1 text-sm"
                >
                  {(["fade","wipe-left","wipe-right","wipe-up","wipe-down","instant"] as RevealAnimation[]).map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
              <NumRow label="Start (ms)" value={selectedTimeline.startMs} step={50} onChange={(v) => updateTimeline(selectedTimeline.regionId, { startMs: Math.max(0, v) })} />
              <NumRow label="Duration (ms)" value={selectedTimeline.durationMs} step={50} onChange={(v) => updateTimeline(selectedTimeline.regionId, { durationMs: Math.max(50, v) })} />
              <div>
                <label className="text-xs text-slate-500">Ease</label>
                <select
                  value={selectedTimeline.ease}
                  onChange={(e) => updateTimeline(selectedTimeline.regionId, { ease: e.target.value as TimelineItem["ease"] })}
                  className="mt-1 w-full rounded-md border px-2 py-1 text-sm"
                >
                  <option value="linear">linear</option>
                  <option value="ease-out">ease-out</option>
                  <option value="ease-in-out">ease-in-out</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-500">Select a region from the left.</div>
          )}
        </aside>
      </div>

      {/* Bottom transport */}
      <div className="flex items-center gap-3 border-t bg-white px-4 py-2">
        {!playing ? (
          <button onClick={play} className="rounded-md bg-slate-900 px-3 py-1 text-sm text-white">Play</button>
        ) : (
          <button onClick={pause} className="rounded-md bg-slate-900 px-3 py-1 text-sm text-white">Pause</button>
        )}
        <button onClick={restart} className="rounded-md border px-3 py-1 text-sm">Restart</button>
        <input
          type="range"
          min={0}
          max={duration}
          value={timeMs}
          step={10}
          onChange={(e) => { setPlaying(false); offsetRef.current = Number(e.target.value); setTimeMs(Number(e.target.value)); }}
          className="flex-1"
        />
        <span className="w-24 text-right font-mono text-xs text-slate-500">
          {(timeMs / 1000).toFixed(2)}s / {(duration / 1000).toFixed(2)}s
        </span>
      </div>
    </div>
  );
}

function NumRow({ label, value, onChange, step = 0.1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-24 text-xs text-slate-500">{label}</label>
      <input
        type="number"
        value={Number.isFinite(value) ? +value.toFixed(2) : 0}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 rounded-md border px-2 py-1 text-sm"
      />
    </div>
  );
}

function CanvasStage({
  imageUrl, template, scene, timeMs, selectedId, showOutlines, onSelect,
}: {
  imageUrl: string;
  template: MaskTemplate;
  scene: SceneState;
  timeMs: number;
  selectedId: string | null;
  showOutlines: boolean;
  onSelect: (id: string) => void;
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const aspect = natural ? natural.w / natural.h : template.aspect;

  return (
    <div className="w-full max-w-5xl">
      <div
        className="relative w-full overflow-hidden rounded-lg border bg-white shadow-sm"
        style={{ aspectRatio: `${aspect}` }}
      >
        <img
          src={imageUrl}
          alt="scene"
          className="absolute inset-0 h-full w-full object-contain"
          onLoad={(e) => {
            const img = e.currentTarget;
            setNatural({ w: img.naturalWidth, h: img.naturalHeight });
          }}
        />
        {scene.regions.map((r) => {
          const item = scene.timeline.find((t) => t.regionId === r.id);
          if (!item) return null;
          const style = computeMaskStyle(item, timeMs);
          const padX = r.padX ?? 0;
          const padY = r.padY ?? 0;
          const left = (r.x - padX) * 100;
          const top = (r.y - padY) * 100;
          const width = (r.w + padX * 2) * 100;
          const height = (r.h + padY * 2) * 100;
          const selected = selectedId === r.id;
          return (
            <div
              key={r.id}
              onClick={() => onSelect(r.id)}
              className="absolute cursor-pointer"
              style={{
                left: `${left}%`,
                top: `${top}%`,
                width: `${width}%`,
                height: `${height}%`,
                background: "#ffffff",
                opacity: style.opacity,
                transform: style.transform,
                transformOrigin: style.transformOrigin,
                outline: showOutlines ? (selected ? "2px solid #0f172a" : "1px dashed #94a3b8") : "none",
                outlineOffset: 0,
              }}
            >
              {showOutlines && (
                <div className="pointer-events-none absolute left-1 top-1 rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  {r.label}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
