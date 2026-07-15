import { useCallback, useRef, useState } from "react";
import { ImagePlus, Upload } from "lucide-react";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

interface ComposeImageUploadProps {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
}

export function ComposeImageUpload({ value, onChange, disabled }: ComposeImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const readFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result;
        if (typeof url === "string") onChange(url);
      };
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
    <div className="space-y-3">
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
        className={`flex min-h-[200px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition ${
          dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30"
        } ${disabled ? "pointer-events-none opacity-60" : ""}`}
      >
        {value ? (
          <>
            <img
              src={value}
              alt="Uploaded composite"
              className="mb-3 max-h-48 max-w-full rounded-md object-contain shadow-sm"
            />
            <p className="text-sm text-muted-foreground">Click or drop to replace image</p>
          </>
        ) : (
          <>
            <Upload className="mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium">Drag and drop an image here</p>
            <p className="mt-1 text-xs text-muted-foreground">or click to browse (PNG, JPG, WebP)</p>
          </>
        )}
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
      {value && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive"
        >
          <ImagePlus size={14} /> Remove image
        </button>
      )}
    </div>
  );
}
