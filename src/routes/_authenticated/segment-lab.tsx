import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { segmentImageLayers } from "@/lib/segment-layers.functions";
import { generateStyledImageWithLabels } from "@/lib/generate-styled.functions";
import {
  extractLayer,
  extractWhiteCover,
  buildResidualCover,
  downloadDataUrl,
  type LayerBitmap,
} from "@/lib/layer-compose";

export const Route = createFileRoute("/_authenticated/segment-lab")({
  ssr: false,
  head: () => ({ meta: [{ title: "Segment Lab · Magic Layer" }] }),
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

interface UILayer extends LayerBitmap {
  id: string;
  label: string;
  visible: boolean;
  zIndex: number;
  offsetX: number;
  offsetY: number;
}

function SegmentLab() {
  const runSegment = useServerFn(segmentImageLayers);
  const runGenerate = useServerFn(generateStyledImageWithLabels);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [knownLabels, setKnownLabels] = useState<string[] | null>(null);
  const [layers, setLayers] = useState<UILayer[]>([]);
  const [covers, setCovers] = useState<
    Array<{ id: string; label: string; bitmap: LayerBitmap; opacity: number }>
  >([]);
  const [mode, setMode] = useState<"reconstruct" | "reveal">("reveal");
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [genPrompt, setGenPrompt] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const revealTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const loadImage = useCallback((url: string) => {
    setImageUrl(url);
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  }, []);

  const onFile = useCallback(
    async (f: File) => {
      setError(null);
      setLayers([]);
      setKnownLabels(null);
      const url = await fileToDataUrl(f);
      loadImage(url);
    },
    [loadImage],
  );

  const generateFromText = useCallback(async () => {
    if (!genPrompt.trim()) return;
    setBusy(true);
    setError(null);
    setLayers([]);
    setKnownLabels(null);
    try {
      setStatus("Planning elements & generating image (GPT + DALL·E)…");
      const res = await runGenerate({ data: { prompt: genPrompt.trim() } });
      loadImage(res.imageDataUrl);
      setKnownLabels(res.labels);
      setStatus(`Generated. ${res.labels.length} labels ready: ${res.labels.join(", ")}`);
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
    setLayers([]);
    setCovers([]);
    try {
      setStatus(
        knownLabels && knownLabels.length > 0
          ? `Segmenting with Grounded-SAM using ${knownLabels.length} known labels…`
          : "Discovering labels (GPT) then segmenting with Grounded-SAM…",
      );
      const res = await runSegment({
        data: { imageDataUrl: imageUrl, labels: knownLabels ?? undefined },
      });
      if (res.fallback || res.error) {
        setError(res.error ?? "Segmentation failed. Please retry in a moment.");
        setStatus("");
        return;
      }
      setStatus(`Got ${res.layers.length} masks. Extracting layers + white covers…`);

      const bitmaps: UILayer[] = [];
      const coverList: Array<{ id: string; label: string; bitmap: LayerBitmap; opacity: number }> = [];
      for (let i = 0; i < res.layers.length; i++) {
        const l = res.layers[i];
        setStatus(`Layer ${i + 1}/${res.layers.length}: ${l.label}`);
        try {
          const [b, cov] = await Promise.all([
            extractLayer(imageUrl, l.maskUrl),
            extractWhiteCover(imageUrl, l.maskUrl),
          ]);
          bitmaps.push({
            ...b,
            id: l.id,
            label: l.label,
            visible: true,
            zIndex: 0,
            offsetX: 0,
            offsetY: 0,
          });
          if (cov.area > 0 && cov.pngUrl) {
            coverList.push({ id: l.id, label: l.label, bitmap: cov, opacity: 1 });
          }
        } catch (e) {
          console.warn("Layer extract failed:", l.label, e);
        }
      }

      // Residual cover: catches everything SAM missed (stray strokes, text bits).
      setStatus("Building residual white cover for uncovered ink…");
      try {
        const residual = await buildResidualCover(
          imageUrl,
          res.layers.map((l) => l.maskUrl),
        );
        if (residual.area > 0 && residual.pngUrl) {
          coverList.push({
            id: "__residual__",
            label: "misc ink",
            bitmap: residual,
            opacity: 1,
          });
        }
      } catch (e) {
        console.warn("Residual cover failed:", e);
      }

      // z-index: smaller area = higher (on top)
      bitmaps.sort((a, b) => b.area - a.area);
      bitmaps.forEach((b, i) => (b.zIndex = i));
      setLayers(bitmaps);

      // Reveal order: top-to-bottom, left-to-right within the same row.
      // Residual (stray ink) always last.
      const ROW_TOL = 60; // px tolerance to consider two elements on the same row
      coverList.sort((a, b) => {
        if (a.id === "__residual__") return 1;
        if (b.id === "__residual__") return -1;
        const ay = a.bitmap.bbox.y;
        const by = b.bitmap.bbox.y;
        if (Math.abs(ay - by) > ROW_TOL) return ay - by;
        return a.bitmap.bbox.x - b.bitmap.bbox.x;
      });
      setCovers(coverList);
      setMode("reveal");
      setStatus(`Done — ${bitmaps.length} layers, ${coverList.length} covers. Hit "Play reveal".`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }, [imageUrl, runSegment, knownLabels]);

  const clearRevealTimers = useCallback(() => {
    revealTimers.current.forEach((t) => clearTimeout(t));
    revealTimers.current = [];
  }, []);

  const resetReveal = useCallback(() => {
    clearRevealTimers();
    setCovers((cs) => cs.map((c) => ({ ...c, opacity: 1 })));
  }, [clearRevealTimers]);

  const playReveal = useCallback(() => {
    clearRevealTimers();
    // Reset then fade covers out sequentially with a 400ms stagger.
    setCovers((cs) => cs.map((c) => ({ ...c, opacity: 1 })));
    const STAGGER = 400;
    covers.forEach((_, i) => {
      const t = setTimeout(() => {
        setCovers((cs) =>
          cs.map((c, j) => (j === i ? { ...c, opacity: 0 } : c)),
        );
      }, 200 + i * STAGGER);
      revealTimers.current.push(t);
    });
  }, [covers, clearRevealTimers]);

  const toggle = (id: string) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));

  const setOffset = (id: string, dx: number, dy: number) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, offsetX: dx, offsetY: dy } : l)));

  const resetOffsets = () =>
    setLayers((ls) => ls.map((l) => ({ ...l, offsetX: 0, offsetY: 0 })));

  const previewScale = useMemo(() => {
    if (!imgSize) return 1;
    return Math.min(1, 700 / imgSize.w);
  }, [imgSize]);

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="border-b bg-white px-6 py-4">
        <h1 className="text-xl font-semibold">Segment Lab — Magic Layer</h1>
        <p className="text-sm text-neutral-600">
          Generate an Excalidraw-style image from text (or upload one) → segment it into transparent layers via Grounded-SAM.
        </p>
      </div>

      <div className="grid grid-cols-[320px_1fr_320px] gap-4 p-4">
        {/* LEFT */}
        <div className="space-y-3 rounded-lg border bg-white p-4">
          <div className="space-y-2 rounded-md border border-dashed border-blue-300 bg-blue-50/50 p-2">
            <div className="text-xs font-semibold text-blue-900">Generate from text</div>
            <textarea
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              placeholder="e.g. Rules for valid Python variable names: cannot start with a number"
              rows={3}
              className="w-full resize-none rounded border border-blue-200 bg-white p-2 text-xs"
            />
            <button
              onClick={generateFromText}
              disabled={busy || !genPrompt.trim()}
              className="w-full rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? "Working…" : "Generate image + labels"}
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
          {knownLabels && knownLabels.length > 0 && (
            <div className="rounded bg-green-50 p-2 text-[11px] text-green-900">
              <div className="font-semibold">Baked-in labels ({knownLabels.length}):</div>
              <div>{knownLabels.join(", ")}</div>
            </div>
          )}
          {imageUrl && (
            <div>
              <img src={imageUrl} alt="source" className="w-full rounded border" />
              <div className="mt-1 text-xs text-neutral-500">
                {imgSize ? `${imgSize.w} × ${imgSize.h}` : ""}
              </div>
            </div>
          )}
          <button
            onClick={analyze}
            disabled={!imageUrl || busy}
            className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Analyzing…" : "Analyze layers"}
          </button>
          {status && <div className="text-xs text-neutral-600">{status}</div>}
          {error && <div className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</div>}
        </div>

        {/* CENTER — preview */}
        <div className="rounded-lg border bg-white p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium">Preview</div>
              <div className="flex overflow-hidden rounded border text-xs">
                <button
                  onClick={() => setMode("reveal")}
                  className={`px-2 py-1 ${mode === "reveal" ? "bg-neutral-900 text-white" : "hover:bg-neutral-50"}`}
                >
                  Reveal
                </button>
                <button
                  onClick={() => setMode("reconstruct")}
                  className={`px-2 py-1 ${mode === "reconstruct" ? "bg-neutral-900 text-white" : "hover:bg-neutral-50"}`}
                >
                  Reconstruct
                </button>
              </div>
            </div>
            <div className="flex gap-1">
              {mode === "reveal" && covers.length > 0 && (
                <>
                  <button
                    onClick={playReveal}
                    className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    ▶ Play reveal
                  </button>
                  <button
                    onClick={resetReveal}
                    className="rounded border px-2 py-1 text-xs hover:bg-neutral-50"
                  >
                    Reset
                  </button>
                </>
              )}
              {mode === "reconstruct" && (
                <button
                  onClick={resetOffsets}
                  className="rounded border px-2 py-1 text-xs hover:bg-neutral-50"
                >
                  Reset offsets
                </button>
              )}
            </div>
          </div>
          {!imgSize && (
            <div className="flex h-96 items-center justify-center text-sm text-neutral-400">
              Upload an image to begin
            </div>
          )}
          {imgSize && mode === "reveal" && (
            <div
              className="relative mx-auto overflow-hidden rounded border bg-white"
              style={{
                width: imgSize.w * previewScale,
                height: imgSize.h * previewScale,
              }}
            >
              {imageUrl && (
                <img
                  src={imageUrl}
                  alt="src"
                  className="absolute inset-0 h-full w-full"
                />
              )}
              {covers.map((c) => (
                <img
                  key={c.id}
                  src={c.bitmap.pngUrl}
                  alt={`cover-${c.label}`}
                  style={{
                    position: "absolute",
                    left: c.bitmap.bbox.x * previewScale,
                    top: c.bitmap.bbox.y * previewScale,
                    width: c.bitmap.bbox.w * previewScale,
                    height: c.bitmap.bbox.h * previewScale,
                    opacity: c.opacity,
                    transition: "opacity 1s ease",
                    pointerEvents: "none",
                  }}
                />
              ))}
              {covers.length === 0 && (
                <div className="absolute bottom-2 right-2 rounded bg-white/80 px-2 py-1 text-[10px] text-neutral-500">
                  Run Analyze to build white covers
                </div>
              )}
            </div>
          )}
          {imgSize && mode === "reconstruct" && (
            <div
              className="relative mx-auto overflow-hidden rounded border bg-[repeating-conic-gradient(#eee_0_25%,#fff_0_50%)] bg-[length:16px_16px]"
              style={{
                width: imgSize.w * previewScale,
                height: imgSize.h * previewScale,
              }}
            >
              {layers.length === 0 && imageUrl && (
                <img src={imageUrl} alt="src" className="absolute inset-0 h-full w-full opacity-60" />
              )}
              {layers.map((l) =>
                l.visible ? (
                  <img
                    key={l.id}
                    src={l.pngUrl}
                    alt={l.label}
                    style={{
                      position: "absolute",
                      left: (l.bbox.x + l.offsetX) * previewScale,
                      top: (l.bbox.y + l.offsetY) * previewScale,
                      width: l.bbox.w * previewScale,
                      height: l.bbox.h * previewScale,
                      zIndex: l.zIndex,
                    }}
                  />
                ) : null,
              )}
            </div>
          )}
        </div>


        {/* RIGHT — layer list */}
        <div className="rounded-lg border bg-white p-4">
          <div className="mb-2 text-sm font-medium">Layers ({layers.length})</div>
          <div className="space-y-2">
            {layers.map((l) => (
              <div key={l.id} className="rounded border p-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={l.visible}
                    onChange={() => toggle(l.id)}
                  />
                  <div className="flex-1 truncate text-sm font-medium">{l.label}</div>
                  <button
                    onClick={() => downloadDataUrl(l.pngUrl, `${l.label.replace(/\s+/g, "-")}.png`)}
                    className="rounded border px-2 py-0.5 text-xs hover:bg-neutral-50"
                  >
                    PNG
                  </button>
                </div>
                <div className="mt-1 flex items-start gap-2">
                  <img
                    src={l.pngUrl}
                    alt={l.label}
                    className="h-16 w-16 rounded border bg-[repeating-conic-gradient(#eee_0_25%,#fff_0_50%)] bg-[length:8px_8px] object-contain"
                  />
                  <div className="flex-1 text-[11px] text-neutral-600">
                    <div>bbox: {l.bbox.x},{l.bbox.y} · {l.bbox.w}×{l.bbox.h}</div>
                    <div>z: {l.zIndex} · area: {l.area}px</div>
                    <div className="mt-1 flex gap-1">
                      <label className="flex-1">
                        dx
                        <input
                          type="range"
                          min={-100}
                          max={100}
                          value={l.offsetX}
                          onChange={(e) => setOffset(l.id, Number(e.target.value), l.offsetY)}
                          className="w-full"
                        />
                      </label>
                      <label className="flex-1">
                        dy
                        <input
                          type="range"
                          min={-100}
                          max={100}
                          value={l.offsetY}
                          onChange={(e) => setOffset(l.id, l.offsetX, Number(e.target.value))}
                          className="w-full"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
