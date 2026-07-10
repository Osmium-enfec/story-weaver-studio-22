import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

// Layout on a 16:9 canvas. Each entry maps to a tile index (0..8, row-major).
// x/y/w/h are fractions of canvas width/height. x/y = top-left.
const COMPOSE_LAYOUT: Array<{ tile: number; x: number; y: number; w: number; h: number }> = [
  { tile: 0, x: 0.10, y: 0.00, w: 0.80, h: 0.15 }, // 1st: 80w x 15h
  { tile: 1, x: 0.20, y: 0.15, w: 0.60, h: 0.10 }, // 2nd: 60w x 10h
  // Row of 4 @ 23w x 65h, centered (4*23=92, side pad 4%)
  { tile: 2, x: 0.04, y: 0.25, w: 0.23, h: 0.65 },
  { tile: 3, x: 0.27, y: 0.25, w: 0.23, h: 0.65 },
  { tile: 4, x: 0.50, y: 0.25, w: 0.23, h: 0.65 },
  { tile: 5, x: 0.73, y: 0.25, w: 0.23, h: 0.65 },
  { tile: 6, x: 0.10, y: 0.90, w: 0.80, h: 0.10 }, // last: 80w x 10h
];

export const Route = createFileRoute("/_authenticated/segment-lab")({
  ssr: false,
  head: () => ({ meta: [{ title: "Segment Lab · 3x3 Grid" }] }),
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

async function sliceInto3x3(dataUrl: string): Promise<string[]> {
  const img = await loadImage(dataUrl);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const cw = Math.floor(W / 3);
  const ch = Math.floor(H / 3);
  const parts: string[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(img, col * cw, row * ch, cw, ch, 0, 0, cw, ch);
      parts.push(canvas.toDataURL("image/png"));
    }
  }
  return parts;
}

function SegmentLab() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [parts, setParts] = useState<string[]>([]);
  const [composed, setComposed] = useState<string | null>(null);
  const composeCanvasRef = useRef<HTMLCanvasElement>(null);
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
      const p = await sliceInto3x3(imageDataUrl);
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
        Upload an image and split it into a 3×3 grid (9 tiles shown in sequence).
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
          {busy ? "Slicing…" : "Slice into 3×3"}
        </button>

        {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      </div>

      {parts.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">
            9 tiles (row-major order)
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {parts.map((src, i) => (
              <div key={i} className="rounded-lg border bg-white p-2">
                <div className="mb-1 text-xs font-mono text-slate-500">#{i + 1}</div>
                <img src={src} alt={`tile-${i + 1}`} className="w-full object-contain" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
