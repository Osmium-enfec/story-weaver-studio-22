import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useRef, useState } from "react";
import { segmentUploadedImage, type CompositeStep } from "@/lib/explainer.functions";
import { cropAndClear } from "@/lib/crop-composite";

export const Route = createFileRoute("/_authenticated/segment-lab")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Segment Lab · Debug" }],
  }),
  component: SegmentLab,
});

type Bbox = { x: number; y: number; w: number; h: number };
type DetType = "text" | "object" | "icon" | "arrow" | "frame";
type DetSource = "gemini" | "florence" | "ocr";
type Element = {
  label: string;
  bbox: Bbox;
  confidence: number;
  type: DetType;
  source: DetSource;
  maskUrl: string | null;
  cropMode: "mask" | "rect" | "white";
};
type Rejected = {
  label: string;
  bbox: Bbox;
  confidence: number;
  type: DetType;
  source: DetSource;
  reason: string;
};
type Result = {
  uploadUrl: string;
  elements: Element[];
  rejected: Rejected[];
  raw: { gemini: number; florence: number; ocr: number };
  steps: CompositeStep[];
};

const SOURCE_COLOR: Record<DetSource, string> = {
  gemini: "bg-blue-100 text-blue-800 border-blue-300",
  florence: "bg-purple-100 text-purple-800 border-purple-300",
  ocr: "bg-emerald-100 text-emerald-800 border-emerald-300",
};
const TYPE_COLOR: Record<DetType, string> = {
  text: "bg-emerald-50 text-emerald-700",
  object: "bg-slate-100 text-slate-700",
  icon: "bg-amber-50 text-amber-700",
  arrow: "bg-rose-50 text-rose-700",
  frame: "bg-indigo-50 text-indigo-700",
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function StepBadge({ s }: { s: CompositeStep }) {
  const cls =
    s.status === "ok"
      ? "bg-emerald-100 text-emerald-800"
      : s.status === "warn"
        ? "bg-amber-100 text-amber-800"
        : "bg-red-100 text-red-800";
  const icon = s.status === "ok" ? "✓" : s.status === "warn" ? "!" : "✕";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${cls}`}
      title={s.message}
    >
      {icon} {s.name}
      {s.message ? ` · ${s.message}` : ""}
    </span>
  );
}

function SegmentLab() {
  const runFn = useServerFn(segmentUploadedImage);
  const inputRef = useRef<HTMLInputElement>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<"fine" | "coarse">("fine");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [crops, setCrops] = useState<Record<string, string>>({});
  const [showRejected, setShowRejected] = useState(false);

  const onPickFile = useCallback(async (f: File | null) => {
    if (!f) return;
    setError(null);
    setResult(null);
    setCrops({});
    const url = await fileToDataUrl(f);
    setImageDataUrl(url);
  }, []);

  const run = async () => {
    if (!imageDataUrl) {
      setError("Upload an image first");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setCrops({});
    try {
      const r = (await runFn({ data: { imageDataUrl, granularity } })) as Result;
      setResult(r);
      const next: Record<string, string> = {};
      await Promise.all(
        r.elements.map(async (el, i) => {
          try {
            const dataUrl = await cropAndClear(
              imageDataUrl,
              el.bbox,
              el.type === "text" ? 0.01 : 0.04,
              el.maskUrl ?? undefined,
              el.cropMode,
            );
            next[`${i}-${el.label}`] = dataUrl;
          } catch (e) {
            console.warn("crop failed", el.label, e);
          }
        }),
      );
      setCrops(next);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const sourceCounts = useMemo(() => {
    if (!result) return null;
    const c = { gemini: 0, florence: 0, ocr: 0 };
    for (const e of result.elements) c[e.source]++;
    return c;
  }, [result]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-semibold">Segment Lab</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Runs three detectors in parallel (Gemini vision · Florence-2 regions · Florence-2 OCR),
        reconciles overlapping boxes, then extracts each element (SAM masks for objects, plain
        rectangles for text).
      </p>

      <div className="space-y-4 rounded-xl border bg-white p-5 shadow-sm">
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) onPickFile(f);
          }}
          className="flex h-40 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500 hover:bg-slate-100"
        >
          {imageDataUrl ? (
            <img src={imageDataUrl} alt="uploaded" className="max-h-36 object-contain" />
          ) : (
            "Click or drop an image here"
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Granularity</label>
          <div className="flex gap-2">
            {(["fine", "coarse"] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  granularity === g
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {g === "fine" ? "Every visible object" : "Semantic groups"}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Fine = list icons, arrows, labels separately. Coarse = group related items into panels.
          </p>
        </div>

        <button
          onClick={run}
          disabled={busy || !imageDataUrl}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Running…" : "Run segmentation"}
        </button>

        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}
      </div>

      {result && (
        <div className="mt-8 space-y-6">
          <div className="flex flex-wrap gap-2">
            {result.steps.map((s, i) => (
              <StepBadge key={i} s={s} />
            ))}
          </div>

          {sourceCounts && (
            <div className="flex flex-wrap gap-3 text-xs text-slate-600">
              <span>
                Raw: gemini {result.raw.gemini} · florence {result.raw.florence} · ocr {result.raw.ocr}
              </span>
              <span>·</span>
              <span>
                Kept: gemini {sourceCounts.gemini} · florence {sourceCounts.florence} · ocr {sourceCounts.ocr}
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">
                Source with reconciled bboxes
              </h2>
              <div className="relative overflow-hidden rounded-lg border bg-white">
                <img src={result.uploadUrl} alt="source" className="w-full" />
                {result.elements.map((el, i) => {
                  const color =
                    el.source === "gemini"
                      ? "border-blue-500/80"
                      : el.source === "florence"
                        ? "border-purple-500/80"
                        : "border-emerald-500/80";
                  const bg =
                    el.source === "gemini"
                      ? "bg-blue-500"
                      : el.source === "florence"
                        ? "bg-purple-500"
                        : "bg-emerald-500";
                  return (
                    <div
                      key={i}
                      className={`pointer-events-none absolute border-2 ${color}`}
                      style={{
                        left: `${el.bbox.x * 100}%`,
                        top: `${el.bbox.y * 100}%`,
                        width: `${el.bbox.w * 100}%`,
                        height: `${el.bbox.h * 100}%`,
                      }}
                    >
                      <span className={`absolute -top-5 left-0 rounded px-1 text-[10px] text-white ${bg}`}>
                        {el.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">
                Kept elements ({result.elements.length})
              </h2>
              <div className="max-h-96 space-y-1 overflow-auto rounded-lg border bg-slate-50 p-3 text-xs font-mono">
                {result.elements.map((d, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1">
                    <span className={`rounded border px-1 ${SOURCE_COLOR[d.source]}`}>
                      {d.source}
                    </span>
                    <span className={`rounded px-1 ${TYPE_COLOR[d.type]}`}>{d.type}</span>
                    <span className="font-semibold">{d.label}</span>
                    <span className="text-slate-500">
                      · conf {d.confidence.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Extracted elements</h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {result.elements.map((el, i) => {
                const cropKey = `${i}-${el.label}`;
                return (
                  <div key={i} className="rounded-lg border bg-white p-3">
                    <div
                      className="mb-2 flex h-40 items-center justify-center rounded"
                      style={{
                        backgroundImage:
                          "linear-gradient(45deg, #eee 25%, transparent 25%), linear-gradient(-45deg, #eee 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #eee 75%), linear-gradient(-45deg, transparent 75%, #eee 75%)",
                        backgroundSize: "16px 16px",
                        backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
                      }}
                    >
                      {crops[cropKey] ? (
                        <img
                          src={crops[cropKey]}
                          alt={el.label}
                          className="max-h-40 max-w-full object-contain"
                        />
                      ) : (
                        <span className="text-xs text-slate-400">cropping…</span>
                      )}
                    </div>
                    <div className="text-xs font-semibold">{el.label}</div>
                    <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                      <span className={`rounded border px-1 ${SOURCE_COLOR[el.source]}`}>
                        {el.source}
                      </span>
                      <span className={`rounded px-1 ${TYPE_COLOR[el.type]}`}>{el.type}</span>
                      <span className="text-slate-500">
                        {el.cropMode} · {el.maskUrl ? "mask ✓" : "no mask"}
                      </span>
                    </div>
                    {el.maskUrl && (
                      <a
                        href={el.maskUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block text-[10px] text-blue-600 underline"
                      >
                        raw mask
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {result.rejected.length > 0 && (
            <div className="rounded-lg border bg-slate-50 p-4">
              <button
                onClick={() => setShowRejected((v) => !v)}
                className="text-sm font-semibold text-slate-700"
              >
                {showRejected ? "▼" : "▶"} Rejected detections ({result.rejected.length})
              </button>
              {showRejected && (
                <div className="mt-3 space-y-1 font-mono text-xs">
                  {result.rejected.map((r, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-1">
                      <span className={`rounded border px-1 ${SOURCE_COLOR[r.source]}`}>
                        {r.source}
                      </span>
                      <span className={`rounded px-1 ${TYPE_COLOR[r.type]}`}>{r.type}</span>
                      <span>{r.label}</span>
                      <span className="text-slate-500">· {r.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
