import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { detectBoxesInImage, type DetectedBox } from "@/lib/detect-boxes.functions";
import { generateStyledImageWithLabels } from "@/lib/generate-styled.functions";

export const Route = createFileRoute("/_authenticated/segment-lab")({
  ssr: false,
  head: () => ({ meta: [{ title: "Segment Lab · Box Reveal" }] }),
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

interface OrderedBox extends DetectedBox {
  opacity: number;
}

function SegmentLab() {
  const runDetect = useServerFn(detectBoxesInImage);
  const runGenerate = useServerFn(generateStyledImageWithLabels);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [boxes, setBoxes] = useState<OrderedBox[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [genPrompt, setGenPrompt] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const revealTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const loadImage = useCallback((url: string) => {
    setImageUrl(url);
    setBoxes([]);
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  }, []);

  const onFile = useCallback(
    async (f: File) => {
      setError(null);
      const url = await fileToDataUrl(f);
      loadImage(url);
    },
    [loadImage],
  );

  const generateFromText = useCallback(async () => {
    if (!genPrompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setStatus("Generating hand-drawn infographic…");
      const res = await runGenerate({ data: { prompt: genPrompt.trim() } });
      loadImage(res.imageDataUrl);
      setStatus("Generated. Hit Detect boxes.");
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }, [genPrompt, runGenerate, loadImage]);

  const analyze = useCallback(async () => {
    if (!imageUrl) return;
    setBusy(true);
    setError(null);
    setBoxes([]);
    try {
      setStatus("Detecting hand-drawn boxes (Grounding-DINO)…");
      const res = await runDetect({ data: { imageDataUrl: imageUrl } });
      if (res.fallback || res.error) {
        setError(res.error ?? "Detection failed.");
        setStatus("");
        return;
      }
      // Sort top-to-bottom, left-to-right (row tolerance = 5% of image height).
      const rowTol = 0.05;
      const sorted = [...res.boxes].sort((a, b) => {
        const ay = a.bbox.y + a.bbox.h / 2;
        const by = b.bbox.y + b.bbox.h / 2;
        if (Math.abs(ay - by) > rowTol) return ay - by;
        return a.bbox.x + a.bbox.w / 2 - (b.bbox.x + b.bbox.w / 2);
      });
      setBoxes(sorted.map((b) => ({ ...b, opacity: 1 })));
      setStatus(`Found ${sorted.length} boxes. Hit ▶ Play reveal.`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }, [imageUrl, runDetect]);

  const clearTimers = useCallback(() => {
    revealTimers.current.forEach((t) => clearTimeout(t));
    revealTimers.current = [];
  }, []);

  const resetReveal = useCallback(() => {
    clearTimers();
    setBoxes((bs) => bs.map((b) => ({ ...b, opacity: 1 })));
  }, [clearTimers]);

  const playReveal = useCallback(() => {
    clearTimers();
    setBoxes((bs) => bs.map((b) => ({ ...b, opacity: 1 })));
    const INTERVAL = 900;
    const START = 250;
    boxes.forEach((_, i) => {
      const t = setTimeout(() => {
        setBoxes((bs) => bs.map((b, j) => (j === i ? { ...b, opacity: 0 } : b)));
      }, START + i * INTERVAL);
      revealTimers.current.push(t);
    });
  }, [boxes, clearTimers]);

  const previewScale = useMemo(() => {
    if (!imgSize) return 1;
    return Math.min(1, 900 / imgSize.w);
  }, [imgSize]);

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="border-b bg-white px-6 py-4">
        <h1 className="text-xl font-semibold">Segment Lab — Box Reveal</h1>
        <p className="text-sm text-neutral-600">
          Generate or upload an image, detect hand-drawn boxes, then reveal them one-by-one (top → bottom, left → right).
        </p>
      </div>

      <div className="grid grid-cols-[320px_1fr] gap-4 p-4">
        {/* LEFT */}
        <div className="space-y-3 rounded-lg border bg-white p-4">
          <div className="space-y-2 rounded-md border border-dashed border-blue-300 bg-blue-50/50 p-2">
            <div className="text-xs font-semibold text-blue-900">Generate from text</div>
            <textarea
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              placeholder="e.g. Rules for valid Python variable names"
              rows={3}
              className="w-full resize-none rounded border border-blue-200 bg-white p-2 text-xs"
            />
            <button
              onClick={generateFromText}
              disabled={busy || !genPrompt.trim()}
              className="w-full rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? "Working…" : "Generate image"}
            </button>
          </div>

          <div className="text-center text-[10px] uppercase tracking-wider text-neutral-400">
            or upload
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) onFile(f);
            }}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-28 cursor-pointer items-center justify-center rounded-md border-2 border-dashed border-neutral-300 text-sm text-neutral-500 hover:bg-neutral-50"
          >
            {imageUrl ? "Drop new image or click" : "Drop image or click to upload"}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />

          <button
            onClick={analyze}
            disabled={!imageUrl || busy}
            className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Detecting…" : "Detect boxes"}
          </button>
          {status && <div className="text-xs text-neutral-600">{status}</div>}
          {error && <div className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</div>}

          {boxes.length > 0 && (
            <div className="rounded bg-neutral-100 p-2 text-[11px] text-neutral-700">
              <div className="mb-1 font-semibold">Reveal order ({boxes.length}):</div>
              <ol className="list-decimal space-y-0.5 pl-4">
                {boxes.map((b, i) => (
                  <li key={b.id}>
                    y={b.bbox.y.toFixed(2)} · x={b.bbox.x.toFixed(2)} · {(b.bbox.w * 100).toFixed(0)}×{(b.bbox.h * 100).toFixed(0)}%
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* PREVIEW */}
        <div className="rounded-lg border bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Preview</div>
            <div className="flex gap-1">
              {boxes.length > 0 && (
                <>
                  <button
                    onClick={playReveal}
                    className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    ▶ Play reveal
                  </button>
                  <button
                    onClick={resetReveal}
                    className="rounded border px-3 py-1 text-xs hover:bg-neutral-50"
                  >
                    Reset
                  </button>
                </>
              )}
            </div>
          </div>

          {!imgSize && (
            <div className="flex h-96 items-center justify-center text-sm text-neutral-400">
              Generate or upload an image to begin
            </div>
          )}

          {imgSize && imageUrl && (
            <div
              className="relative mx-auto overflow-hidden rounded border bg-white"
              style={{
                width: imgSize.w * previewScale,
                height: imgSize.h * previewScale,
              }}
            >
              <img src={imageUrl} alt="src" className="absolute inset-0 h-full w-full" />
              {boxes.map((b, i) => (
                <div
                  key={b.id}
                  style={{
                    position: "absolute",
                    left: `${b.bbox.x * 100}%`,
                    top: `${b.bbox.y * 100}%`,
                    width: `${b.bbox.w * 100}%`,
                    height: `${b.bbox.h * 100}%`,
                    background: "#FFFFFF",
                    opacity: b.opacity,
                    transition: "opacity 900ms ease",
                    pointerEvents: "none",
                    borderRadius: 6,
                  }}
                >
                  {b.opacity > 0.5 && (
                    <div className="absolute left-1 top-1 rounded bg-neutral-900/70 px-1 text-[10px] text-white">
                      {i + 1}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
