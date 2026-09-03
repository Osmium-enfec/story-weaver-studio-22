import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Crop,
  Eraser,
  Pencil,
  RotateCcw,
  Save,
  Type,
  Undo2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ComposeCrop } from "@/lib/compose-scene";
import {
  EXCALIFONT_STACK,
  canvasFont,
  ensureExcalifontLoaded,
} from "@/lib/scene-font";

const PEN_COLORS = [
  "#111827",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#ffffff",
] as const;

const PEN_WIDTHS = [2, 4, 8, 14, 22] as const;
const TEXT_SIZES = [18, 24, 32, 48, 64] as const;

type AnnotateTool = "pen" | "eraser" | "erase-rect" | "text";

interface CropAnnotateDialogProps {
  crop: ComposeCrop | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (cropId: string, imageUrl: string) => void;
}

function normRect(a: { x: number; y: number }, b: { x: number; y: number }) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  return { x, y, w, h };
}

export function CropAnnotateDialog({
  crop,
  open,
  onOpenChange,
  onSave,
}: CropAnnotateDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const selStartRef = useRef<{ x: number; y: number } | null>(null);

  const [color, setColor] = useState<string>(PEN_COLORS[0]!);
  const [width, setWidth] = useState<number>(PEN_WIDTHS[1]!);
  const [tool, setTool] = useState<AnnotateTool>("pen");
  const [textValue, setTextValue] = useState("");
  const [textSize, setTextSize] = useState<number>(TEXT_SIZES[2]!);
  const [snapshots, setSnapshots] = useState<ImageData[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selPreview, setSelPreview] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!open || !crop) return;
    let cancelled = false;

    const load = async () => {
      await ensureExcalifontLoaded();
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (cancelled) return;
        const w = Math.max(1, img.naturalWidth || img.width);
        const h = Math.max(1, img.naturalHeight || img.height);
        canvas.width = w;
        canvas.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        setSnapshots([ctx.getImageData(0, 0, w, h)]);
        setDirty(false);
        setTool("pen");
        setSelPreview(null);
        setTextValue("");
        requestAnimationFrame(() => syncDisplaySize());
      };
      img.src = crop.imageUrl;
    };

    const raf = requestAnimationFrame(() => {
      void load();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [open, crop?.id, crop?.imageUrl]);

  function syncDisplaySize() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    setDisplaySize({ w: rect.width, h: rect.height });
  }

  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function pushSnapshot() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setSnapshots((prev) => {
      const next = [...prev, snap];
      return next.length > 40 ? next.slice(next.length - 40) : next;
    });
  }

  function applyBrushStyle(ctx: CanvasRenderingContext2D) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = width;
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = color;
    }
  }

  function stampText(x: number, y: number) {
    const value = textValue.trim();
    if (!value) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    pushSnapshot();
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = color;
    ctx.font = canvasFont(600, textSize);
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const lines = value.replace(/\r\n/g, "\n").split("\n");
    const lineH = textSize * 1.25;
    lines.forEach((line, i) => {
      ctx.fillText(line, x, y + i * lineH);
    });
    ctx.restore();
    setDirty(true);
  }

  function eraseRect(a: { x: number; y: number }, b: { x: number; y: number }) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const r = normRect(a, b);
    if (r.w < 2 && r.h < 2) return;
    pushSnapshot();
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
    setDirty(true);
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!crop) return;
    syncDisplaySize();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = canvasPoint(e);

    if (tool === "text") {
      stampText(p.x, p.y);
      return;
    }

    if (tool === "erase-rect") {
      drawingRef.current = true;
      selStartRef.current = p;
      setSelPreview({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }

    drawingRef.current = true;
    lastRef.current = p;
    pushSnapshot();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    applyBrushStyle(ctx);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y);
    ctx.stroke();
    setDirty(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const p = canvasPoint(e);

    if (tool === "erase-rect") {
      const start = selStartRef.current;
      if (!start) return;
      setSelPreview(normRect(start, p));
      return;
    }

    if (tool !== "pen" && tool !== "eraser") return;
    const ctx = canvasRef.current?.getContext("2d");
    const last = lastRef.current;
    if (!ctx || !last) return;
    applyBrushStyle(ctx);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    setDirty(true);
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === "erase-rect" && drawingRef.current && selStartRef.current) {
      const p = canvasPoint(e);
      eraseRect(selStartRef.current, p);
    }
    drawingRef.current = false;
    lastRef.current = null;
    selStartRef.current = null;
    setSelPreview(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  function undo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || snapshots.length <= 1) return;
    const next = snapshots.slice(0, -1);
    const snap = next[next.length - 1]!;
    ctx.putImageData(snap, 0, 0);
    setSnapshots(next);
    setDirty(next.length > 1);
  }

  function reset() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || snapshots.length === 0) return;
    const first = snapshots[0]!;
    ctx.putImageData(first, 0, 0);
    setSnapshots([first]);
    setDirty(false);
  }

  async function save() {
    if (!crop || saving) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaveError(null);
    setSaving(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png"),
      );
      const dataUrl = blob
        ? await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("Read failed"));
            reader.readAsDataURL(blob);
          })
        : canvas.toDataURL("image/png");
      await onSave(crop.id, dataUrl);
      onOpenChange(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }


  const canvas = canvasRef.current;
  const scaleX =
    canvas && displaySize.w > 0 ? displaySize.w / Math.max(1, canvas.width) : 1;
  const scaleY =
    canvas && displaySize.h > 0 ? displaySize.h / Math.max(1, canvas.height) : 1;

  const toolBtn = (id: AnnotateTool, label: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => {
        setTool(id);
        setSelPreview(null);
      }}
      className={`inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs ${
        tool === id ? "border-primary bg-primary/10" : "hover:bg-accent"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col gap-3 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit “{crop?.name ?? "crop"}”</DialogTitle>
          <DialogDescription>
            Draw, erase a selected area, or add Excalifont text. Saved edits apply to timeline,
            preview, and download.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {toolBtn("pen", "Pen", <Pencil size={12} />)}
          {toolBtn("eraser", "Eraser", <Eraser size={12} />)}
          {toolBtn("erase-rect", "Select erase", <Crop size={12} />)}
          {toolBtn("text", "Text", <Type size={12} />)}
          <button
            type="button"
            onClick={undo}
            disabled={snapshots.length <= 1}
            className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent disabled:opacity-40"
          >
            <Undo2 size={12} /> Undo
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={!dirty}
            className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent disabled:opacity-40"
          >
            <RotateCcw size={12} /> Reset
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Color</span>
          <div className="flex flex-wrap gap-1.5">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => {
                  setColor(c);
                  if (tool === "eraser" || tool === "erase-rect") setTool("pen");
                }}
                className={`h-7 w-7 rounded-full border-2 ${
                  (tool === "pen" || tool === "text") && color === c
                    ? "border-primary ring-2 ring-primary/30"
                    : "border-border"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          {(tool === "pen" || tool === "eraser") && (
            <>
              <span className="ml-2 text-xs font-medium text-muted-foreground">Width</span>
              <div className="flex flex-wrap gap-1">
                {PEN_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWidth(w)}
                    className={`inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-xs ${
                      width === w ? "border-primary bg-primary/10 font-medium" : "hover:bg-accent"
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </>
          )}
          {tool === "text" && (
            <>
              <span className="ml-2 text-xs font-medium text-muted-foreground">Size</span>
              <div className="flex flex-wrap gap-1">
                {TEXT_SIZES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setTextSize(s)}
                    className={`inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-xs ${
                      textSize === s
                        ? "border-primary bg-primary/10 font-medium"
                        : "hover:bg-accent"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {tool === "erase-rect" && (
          <p className="text-xs text-muted-foreground">
            Drag a rectangle over the area to erase, then release.
          </p>
        )}

        {tool === "text" && (
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">
              Text (Excalifont) — type here, then click the image to place
            </label>
            <textarea
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              rows={2}
              placeholder="Enter text…"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              style={{ fontFamily: EXCALIFONT_STACK }}
            />
          </div>
        )}

        <div
          ref={wrapRef}
          className="relative min-h-0 flex-1 overflow-auto rounded-md border bg-muted/40 p-2"
        >
          <div className="relative mx-auto inline-block max-w-full">
            <canvas
              ref={canvasRef}
              className={`block max-h-[50vh] max-w-full touch-none ${
                tool === "text"
                  ? "cursor-text"
                  : tool === "erase-rect"
                    ? "cursor-crosshair"
                    : "cursor-crosshair"
              }`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
            {selPreview && displaySize.w > 0 && (
              <div
                className="pointer-events-none absolute border-2 border-dashed border-red-500 bg-red-500/15"
                style={{
                  left: selPreview.x * scaleX,
                  top: selPreview.y * scaleY,
                  width: Math.max(1, selPreview.w * scaleX),
                  height: Math.max(1, selPreview.h * scaleY),
                }}
              />
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            <Save size={14} /> Save drawing
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
