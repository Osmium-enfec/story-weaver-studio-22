import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  cropImageToDataUrl,
  imageFitRect,
  screenRectToNormBbox,
  type ComposeCrop,
} from "@/lib/compose-scene";

interface CropCanvasProps {
  imageUrl: string;
  bgAspect: number;
  crops: ComposeCrop[];
  onAddCrop: (crop: ComposeCrop) => void;
  selectedCropId: string | null;
  onSelectCrop: (id: string | null) => void;
}

export function CropCanvas({
  imageUrl,
  bgAspect,
  crops,
  onAddCrop,
  selectedCropId,
  onSelectCrop,
}: CropCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [fit, setFit] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  const [cropName, setCropName] = useState("");

  const recomputeFit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = imageFitRect(el.clientWidth, el.clientHeight, bgAspect);
    setFit(r);
  }, [bgAspect]);

  useLayoutEffect(() => {
    recomputeFit();
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recomputeFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recomputeFit, imageUrl]);

  function pointerToLocal(e: React.PointerEvent): { x: number; y: number } {
    const el = containerRef.current!;
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const p = pointerToLocal(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const p = pointerToLocal(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  }

  function onPointerUp() {
    if (!drag) return;
    const left = Math.min(drag.x0, drag.x1);
    const top = Math.min(drag.y0, drag.y1);
    const width = Math.abs(drag.x1 - drag.x0);
    const height = Math.abs(drag.y1 - drag.y0);
    setDrag(null);

    const bbox = screenRectToNormBbox(left, top, width, height, fit);
    const img = imgRef.current;
    if (!bbox || !img?.complete) return;

    const imageUrlCrop = cropImageToDataUrl(img, bbox);
    const id = `crop-${Date.now()}`;
    const name = cropName.trim() || `Element ${crops.length + 1}`;
    onAddCrop({ id, name, imageUrl: imageUrlCrop, bbox });
    onSelectCrop(id);
    setCropName("");
  }

  const selLeft = drag ? Math.min(drag.x0, drag.x1) : 0;
  const selTop = drag ? Math.min(drag.y0, drag.y1) : 0;
  const selW = drag ? Math.abs(drag.x1 - drag.x0) : 0;
  const selH = drag ? Math.abs(drag.y1 - drag.y0) : 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={cropName}
          onChange={(e) => setCropName(e.target.value)}
          placeholder="Name for next crop (optional)"
          className="h-9 flex-1 min-w-[160px] rounded-md border bg-background px-3 text-sm"
        />
        <span className="text-xs text-muted-foreground">Drag on image to crop</span>
      </div>
      <div
        ref={containerRef}
        className="relative aspect-video w-full cursor-crosshair overflow-hidden rounded-lg border bg-white"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {fit.w > 0 && (
          <div
            className="absolute"
            style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h }}
          >
            <img
              ref={imgRef}
              src={imageUrl}
              alt=""
              draggable={false}
              className="block h-full w-full select-none"
              crossOrigin="anonymous"
            />
            {crops.map((c) => (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelectCrop(c.id);
                }}
                className={`absolute border-2 ${
                  selectedCropId === c.id ? "border-primary bg-primary/10" : "border-blue-400/80"
                }`}
                style={{
                  left: `${c.bbox.x * 100}%`,
                  top: `${c.bbox.y * 100}%`,
                  width: `${c.bbox.w * 100}%`,
                  height: `${c.bbox.h * 100}%`,
                }}
                title={c.name}
              />
            ))}
          </div>
        )}
        {drag && selW > 2 && selH > 2 && (
          <div
            className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/15"
            style={{ left: selLeft, top: selTop, width: selW, height: selH }}
          />
        )}
      </div>
    </div>
  );
}
