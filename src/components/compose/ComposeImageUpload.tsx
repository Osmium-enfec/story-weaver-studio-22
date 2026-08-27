import { useCallback, useRef, useState } from "react";
import { RefreshCw, Trash2, Upload } from "lucide-react";
import { apiPersistAssetFile } from "@/lib/compose-api";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

interface ComposeImageUploadProps {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  /** When set, uploads are stored as project assets so they survive refresh. */
  projectId?: string | null;
  disabled?: boolean;
}

export function ComposeImageUpload({
  value,
  onChange,
  projectId = null,
  disabled,
}: ComposeImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) return;
      setError(null);

      // Persist to project storage first: a data: URL is too large to keep in
      // the autosaved working draft, so it vanishes on refresh.
      if (projectId) {
        setBusy(true);
        try {
          const ext =
            file.name.split(".").pop()?.toLowerCase() ||
            (file.type.split("/")[1] ?? "png");
          const url = await apiPersistAssetFile({ file, projectId, ext });
          onChange(url);
          return;
        } catch (e) {
          setError(
            e instanceof Error
              ? `${e.message} — using a temporary copy that may not survive refresh.`
              : "Upload failed",
          );
        } finally {
          setBusy(false);
        }
      }

      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result;
        if (typeof url === "string") onChange(url);
      };
      reader.readAsDataURL(file);
    },
    [onChange, projectId],
  );


  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (disabled || busy) return;
    const file = e.dataTransfer.files[0];
    if (file) void readFile(file);
  }

  function openPicker() {
    if (!disabled && !busy) inputRef.current?.click();
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        disabled={disabled || busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void readFile(file);
          e.target.value = "";
        }}
      />


      {!value ? (
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") openPicker();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={openPicker}
          className={`flex min-h-[160px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition ${
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30"
          } ${disabled ? "pointer-events-none opacity-60" : ""}`}
        >
          <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">Drag and drop an image here</p>
          <p className="mt-1 text-xs text-muted-foreground">
            or click to browse (PNG, JPG, WebP)
          </p>
        </div>
      ) : (
        <div
          className={`space-y-2 rounded-lg border bg-muted/10 p-2 ${
            dragOver ? "border-primary bg-primary/5" : ""
          } ${disabled ? "opacity-60" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <img
            src={value}
            alt="Uploaded"
            className="mx-auto max-h-48 max-w-full rounded-md border object-contain"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
            <span className="text-xs text-muted-foreground">
              Image ready — drop a file to replace
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={openPicker}
                className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Replace
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(null)}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
