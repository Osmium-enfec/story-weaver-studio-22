import { useCallback, useRef, useState } from "react";
import { Trash2, Upload } from "lucide-react";

const ACCEPT = "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/m4a,audio/webm,audio/ogg";

interface ComposeAudioUploadProps {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
}

/** Upload narration audio instead of generating it with TTS. */
export function ComposeAudioUpload({ value, onChange, disabled }: ComposeAudioUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("audio/")) {
        setError("That file is not audio. Use MP3, WAV, M4A, OGG, or WebM.");
        return;
      }
      setError(null);
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result;
        if (typeof url === "string") onChange(url);
      };
      reader.onerror = () => setError("Could not read that file.");
      reader.readAsDataURL(file);
    },
    [onChange],
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  }

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition ${
          dragOver
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30"
        } ${disabled ? "pointer-events-none opacity-60" : ""}`}
      >
        <Upload className="mb-2 h-7 w-7 text-muted-foreground" />
        <p className="text-sm font-medium">
          {value ? "Click or drop to replace narration audio" : "Drag and drop narration audio"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">or click to browse (MP3, WAV, M4A, OGG)</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) readFile(file);
          e.target.value = "";
        }}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {value && (
        <div className="space-y-2">
          <audio src={value} controls className="w-full" />
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(null)}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive"
          >
            <Trash2 size={14} /> Remove audio
          </button>
        </div>
      )}
    </div>
  );
}
