import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useRef, useState } from "react";
import { segmentUploadedImage, type CompositeStep } from "@/lib/explainer.functions";
import { cropAndClear } from "@/lib/crop-composite";

export const Route = createFileRoute("/_authenticated/segment-lab")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Segment Lab · Debug" }],
  }),
  component: SegmentLab,
});

type Element = {
  label: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  confidence: number;
  maskUrl: string | null;
};
type Result = {
  uploadUrl: string;
  elements: Element[];
  detections: Array<{ label: string; bbox: any; confidence: number }>;
  steps: CompositeStep[];
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
  const [labelsText, setLabelsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [crops, setCrops] = useState<Record<string, string>>({});

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
    const labels = labelsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    // Empty labels → server auto-detects every element via vision LLM.
    setBusy(true);
    setError(null);
    setResult(null);
    setCrops({});
    try {
      const r = (await runFn({ data: { imageDataUrl, labels } })) as Result;
      setResult(r);
      // Compute client-side crops
      const next: Record<string, string> = {};
      await Promise.all(
        r.elements.map(async (el) => {
          if (!el.bbox) return;
          try {
            const dataUrl = await cropAndClear(
              imageDataUrl,
              el.bbox,
              0.04,
              el.maskUrl ?? undefined,
            );
            next[el.label] = dataUrl;
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

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-semibold">Segment Lab</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Upload any image, list the elements you want to extract (comma-separated),
        and see what Grounding-DINO + SAM return.
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
          <label className="mb-1 block text-sm font-medium">
            Labels (comma-separated)
          </label>
          <input
            type="text"
            value={labelsText}
            onChange={(e) => setLabelsText(e.target.value)}
            placeholder="the dog, the laptop, the magnifying glass"
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">
            Short concrete noun phrases work best (e.g. "the red arrow", "person on the left").
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

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">
                Source (uploaded to Replicate)
              </h2>
              <div className="relative overflow-hidden rounded-lg border bg-white">
                <img src={result.uploadUrl} alt="source" className="w-full" />
                {/* Overlay bboxes */}
                {result.elements.map((el, i) =>
                  el.bbox ? (
                    <div
                      key={i}
                      className="pointer-events-none absolute border-2 border-emerald-500/80"
                      style={{
                        left: `${el.bbox.x * 100}%`,
                        top: `${el.bbox.y * 100}%`,
                        width: `${el.bbox.w * 100}%`,
                        height: `${el.bbox.h * 100}%`,
                      }}
                    >
                      <span className="absolute -top-5 left-0 rounded bg-emerald-500 px-1 text-[10px] text-white">
                        {el.label} {el.confidence ? `· ${el.confidence.toFixed(2)}` : ""}
                      </span>
                    </div>
                  ) : null,
                )}
              </div>
            </div>

            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">
                All raw detections ({result.detections.length})
              </h2>
              <div className="max-h-96 space-y-1 overflow-auto rounded-lg border bg-slate-50 p-3 text-xs font-mono">
                {result.detections.map((d, i) => (
                  <div key={i}>
                    <span className="font-semibold">{d.label}</span>
                    {" — "}
                    conf {Number(d.confidence).toFixed(2)}, bbox [
                    {(Array.isArray(d.bbox) ? d.bbox : [d.bbox?.x, d.bbox?.y, d.bbox?.w, d.bbox?.h])
                      .map((n: any) => Number(n).toFixed(3))
                      .join(", ")}
                    ]
                  </div>
                ))}
                {result.detections.length === 0 && (
                  <div className="text-slate-500">No detections returned.</div>
                )}
              </div>
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-slate-700">
              Extracted elements
            </h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {result.elements.map((el, i) => (
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
                    {crops[el.label] ? (
                      <img
                        src={crops[el.label]}
                        alt={el.label}
                        className="max-h-40 max-w-full object-contain"
                      />
                    ) : (
                      <span className="text-xs text-slate-400">
                        {el.bbox ? "cropping…" : "no match"}
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-semibold">{el.label}</div>
                  <div className="text-[10px] text-slate-500">
                    {el.bbox ? (
                      <>
                        bbox {el.bbox.w.toFixed(2)}×{el.bbox.h.toFixed(2)} · mask{" "}
                        {el.maskUrl ? "✓" : "✕"}
                      </>
                    ) : (
                      "no bbox"
                    )}
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
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
