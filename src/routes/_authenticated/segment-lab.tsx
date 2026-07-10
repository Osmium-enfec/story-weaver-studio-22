import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

// Layout applied to the source image. Each entry crops a rectangle from
// the source in fractions of image width/height (x/y = top-left).
// These normalized boxes match the exact element positions on the user's
// 1659 × 948 px uploaded image.
const SLICE_LAYOUT: Array<{ label: string; x: number; y: number; w: number; h: number }> = [
  { label: "MCQ Answer title banner", x: 339 / 1659, y: 559 / 948, w: 741 / 1659, h: 151 / 948 },
  { label: "Valid Variable Names subtitle", x: 419 / 1659, y: 218 / 948, w: 189 / 1659, h: 43 / 948 },
  { label: "Option A card", x: 113 / 1659, y: 315 / 948, w: 274 / 1659, h: 584 / 948 },
  { label: "Option B card", x: 478 / 1659, y: 315 / 948, w: 331 / 1659, h: 458 / 948 },
  { label: "Option C card", x: 846 / 1659, y: 315 / 948, w: 331 / 1659, h: 458 / 948 },
  { label: "Option D card", x: 1215 / 1659, y: 315 / 948, w: 321 / 1659, h: 458 / 948 },
  { label: "Correct answer banner", x: 322 / 1659, y: 790 / 948, w: 1025 / 1659, h: 114 / 948 },
];

export const Route = createFileRoute("/_authenticated/segment-lab")({
  ssr: false,
  head: () => ({ meta: [{ title: "Segment Lab · Layout Slicer" }] }),
  component: SegmentLab,
});

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function sliceByLayout(dataUrl: string): Promise<string[]> {
  const img = await loadImage(dataUrl);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const parts: string[] = [];
  for (const slot of SLICE_LAYOUT) {
    const sx = Math.round(slot.x * W);
    const sy = Math.round(slot.y * H);
    const sw = Math.round(slot.w * W);
    const sh = Math.round(slot.h * H);
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    parts.push(canvas.toDataURL("image/png"));
  }
  return parts;
}

function SegmentLab() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [parts, setParts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPickFile = useCallback(async (f: File | null) => {
    if (!f) return;
    setError(null);
    setParts([]);
    try {
      const url = await fileToDataUrl(f);
      setImageDataUrl(url);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  const run = async () => {
    if (!imageDataUrl) {
      setError("Upload an image first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const p = await sliceByLayout(imageDataUrl);
      setParts(p);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-semibold">Segment Lab</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Upload an image and slice it into 7 parts using the exact safe boxes for a 1600 × 900 px canvas (title banner, subtitle, four option cards, bottom banner).
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

        <button
          onClick={run}
          disabled={busy || !imageDataUrl}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Slicing…" : "Slice by layout"}
        </button>

        {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      </div>

      {parts.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">
            7 slices (in layout order)
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {parts.map((src, i) => (
              <div key={i} className="rounded-lg border bg-white p-2">
                <div className="mb-1 flex items-center justify-between text-xs font-mono text-slate-500">
                  <span>#{i + 1}</span>
                  <span>{SLICE_LAYOUT[i]?.label}</span>
                </div>
                <img src={src} alt={`slice-${i + 1}`} className="w-full object-contain" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
