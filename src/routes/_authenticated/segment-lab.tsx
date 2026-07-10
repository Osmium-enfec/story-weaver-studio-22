import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { segmentImageLayers } from "@/lib/segment-layers.functions";
import { extractLayerFromBboxMask, downloadDataUrl, type LayerBitmap } from "@/lib/layer-compose";

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
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [layers, setLayers] = useState<UILayer[]>([]);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onFile = useCallback(async (f: File) => {
    setError(null);
    setLayers([]);
    const url = await fileToDataUrl(f);
    setImageUrl(url);
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  }, []);

  const analyze = useCallback(async () => {
    if (!imageUrl) return;
    setBusy(true);
    setError(null);
    setLayers([]);
    try {
      setStatus("Segmenting with Gemini 2.5 Pro (10–30s)…");
      const res = await runSegment({ data: { imageDataUrl: imageUrl } });
      setStatus(`Got ${res.layers.length} masks. Extracting transparent PNGs…`);

      const bitmaps: UILayer[] = [];
      for (let i = 0; i < res.layers.length; i++) {
        const l = res.layers[i];
        setStatus(`Extracting layer ${i + 1}/${res.layers.length}: ${l.label}`);
        try {
          const b = await extractLayerFromBboxMask(imageUrl, l.maskDataUrl, l.box);
          bitmaps.push({
            ...b,
            id: l.id,
            label: l.label,
            visible: true,
            zIndex: 0,
            offsetX: 0,
            offsetY: 0,
          });
        } catch (e) {
          console.warn("Layer extract failed:", l.label, e);
        }
      }
      // z-index: smaller area = higher (on top)
      bitmaps.sort((a, b) => b.area - a.area);
      bitmaps.forEach((b, i) => (b.zIndex = i));
      setLayers(bitmaps);
      setStatus(`Done — ${bitmaps.length} layers extracted.`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }, [imageUrl, runSegment]);

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
          Upload an image → get separate transparent layers via Gemini + Grounded-SAM.
        </p>
      </div>

      <div className="grid grid-cols-[320px_1fr_320px] gap-4 p-4">
        {/* LEFT */}
        <div className="space-y-3 rounded-lg border bg-white p-4">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) onFile(f);
            }}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-40 cursor-pointer items-center justify-center rounded-md border-2 border-dashed border-neutral-300 text-sm text-neutral-500 hover:bg-neutral-50"
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
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Reconstructed preview</div>
            <button
              onClick={resetOffsets}
              className="rounded border px-2 py-1 text-xs hover:bg-neutral-50"
            >
              Reset offsets
            </button>
          </div>
          {!imgSize && (
            <div className="flex h-96 items-center justify-center text-sm text-neutral-400">
              Upload an image to begin
            </div>
          )}
          {imgSize && (
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
