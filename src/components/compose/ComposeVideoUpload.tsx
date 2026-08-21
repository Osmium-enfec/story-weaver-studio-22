import { useCallback, useRef, useState } from "react";
import { RefreshCw, Trash2, Upload } from "lucide-react";
import { apiPersistAssetFile } from "@/lib/compose-api";

const ACCEPT = "video/mp4,video/webm,video/quicktime,video/*";
const MAX_BYTES = 200 * 1024 * 1024; // 200MB

export interface ComposeVideoUploadResult {
  url: string;
  durationMs: number;
  fileName: string;
}

interface ComposeVideoUploadProps {
  value: string | null;
  projectId: string | null;
  onUploaded: (result: ComposeVideoUploadResult) => void;
  onClear: () => void;
  disabled?: boolean;
}

function probeVideoDurationMs(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => {
      const ms = Math.round((v.duration || 0) * 1000);
      v.removeAttribute("src");
      v.load();
      if (ms <= 0 || !Number.isFinite(ms)) {
        reject(new Error("Could not read video duration"));
        return;
      }
      resolve(ms);
    };
    v.onerror = () => reject(new Error("Could not load video metadata"));
    v.src = url;
  });
}

/** Upload a screen recording and persist it to project assets when possible. */
export function ComposeVideoUpload({
  value,
  projectId,
  onUploaded,
  onClear,
  disabled,
}: ComposeVideoUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("video/") && !/\.(mp4|webm|mov)$/i.test(file.name)) {
        setError("That file is not a video. Use MP4, WebM, or MOV.");
        return;
      }
      if (file.size > MAX_BYTES) {
        setError("Video is too large (max 200MB). Compress it and try again.");
        return;
      }
      if (!projectId) {
        setError("Select or create a project part first, then upload.");
        return;
      }

      setError(null);
      setBusy(true);
      const localUrl = URL.createObjectURL(file);
      try {
        const durationMs = await probeVideoDurationMs(localUrl);
        const ext =
          file.name.split(".").pop()?.toLowerCase() ||
          (file.type.includes("webm") ? "webm" : "mp4");
        const url = await apiPersistAssetFile({ file, projectId, ext });
        onUploaded({ url, durationMs, fileName: file.name });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        URL.revokeObjectURL(localUrl);
        setBusy(false);
      }
    },
    [onUploaded, projectId],
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
            if (!disabled && !busy) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={openPicker}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition ${
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30"
          } ${disabled || busy ? "pointer-events-none opacity-60" : ""}`}
        >
          <Upload className="mb-2 h-7 w-7 text-muted-foreground" />
          <p className="text-sm font-medium">
            {busy ? "Uploading…" : "Drag and drop a screen recording"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            or click to browse (MP4, WebM, MOV — max 200MB)
          </p>
        </div>
      ) : (
        <div
          className={`space-y-2 rounded-lg border bg-muted/10 p-2 ${
            dragOver ? "border-primary bg-primary/5" : ""
          } ${disabled || busy ? "opacity-60" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled && !busy) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <video
            src={value}
            controls
            playsInline
            preload="metadata"
            className="max-h-56 w-full rounded-md border bg-black object-contain"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
            <span className="text-xs text-muted-foreground">
              {busy ? "Uploading…" : "Recording ready — drop a file to replace"}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                disabled={disabled || busy}
                onClick={(e) => {
                  e.stopPropagation();
                  openPicker();
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Replace
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                disabled={disabled || busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
