import { useEffect, useMemo, useState } from "react";
import { Loader2, Upload, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiPersistAssetFile } from "@/lib/compose-api";
import {
  DEFAULT_COURSE_SETTINGS,
  VOICE_ENGINE_OPTIONS,
  normalizeCourseSettings,
  type CourseSettings,
} from "@/lib/course-settings";
import { voiceEngineForCourseName } from "@/lib/course-voice";

type MediaField = "bgLoopUrl" | "introUrl" | "outroUrl";

function readVideoDurationMs(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const el = document.createElement("video");
      el.preload = "metadata";
      el.onloadedmetadata = () => {
        const ms = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null;
        URL.revokeObjectURL(url);
        resolve(ms && ms > 0 ? ms : null);
      };
      el.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      el.src = url;
    } catch {
      resolve(null);
    }
  });
}

function VideoField({
  label,
  hint,
  value,
  onPick,
  onClear,
  busy,
}: {
  label: string;
  hint: string;
  value: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
  busy: boolean;
}) {
  const inputId = `course-media-${label.replace(/\s+/g, "-").toLowerCase()}`;
  const [dragOver, setDragOver] = useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const file = Array.from(e.dataTransfer.files).find((f) =>
      f.type.startsWith("video/"),
    );
    if (file) onPick(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`rounded-lg border bg-card p-3 transition ${
        dragOver ? "border-primary ring-2 ring-primary/30" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <label
            htmlFor={inputId}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent"
          >
            {busy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Upload size={13} />
            )}
            {value ? "Replace" : "Upload"}
          </label>
          <input
            id={inputId}
            type="file"
            accept="video/*"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onPick(file);
            }}
          />
          {value ? (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
              title="Use the built-in default"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-2 overflow-hidden rounded-md bg-muted">
        {value ? (
          <video
            src={value}
            className="aspect-video w-full object-cover"
            muted
            loop
            playsInline
            controls
          />
        ) : (
          <div className="flex aspect-video items-center justify-center text-xs text-muted-foreground">
            Using the built-in default
          </div>
        )}
      </div>
    </div>
  );
}

export function CourseSettingsDialog({
  open,
  onOpenChange,
  course,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  course: { id: string; title: string; settings?: CourseSettings | null };
  onSave: (settings: CourseSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<CourseSettings>(
    () => course.settings ?? DEFAULT_COURSE_SETTINGS,
  );
  const [uploading, setUploading] = useState<MediaField | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(normalizeCourseSettings(course.settings));
      setError(null);
    }
  }, [open, course.settings]);

  const effectiveVoice = useMemo(
    () => draft.voiceEngine ?? voiceEngineForCourseName(course.title),
    [draft.voiceEngine, course.title],
  );

  async function upload(field: MediaField, file: File) {
    setUploading(field);
    setError(null);
    try {
      const durationMs = await readVideoDurationMs(file);
      const url = await apiPersistAssetFile({ file, projectId: course.id });
      setDraft((d) => ({
        ...d,
        [field]: url,
        ...(field === "introUrl" ? { introDurationMs: durationMs } : {}),
        ...(field === "outroUrl" ? { outroDurationMs: durationMs } : {}),
        ...(field === "bgLoopUrl" ? { backgroundPreset: "video-loop" as const } : {}),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(null);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{course.title} — settings</DialogTitle>
          <DialogDescription>
            These apply to every episode and part of this course.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-3">
            <div className="text-sm font-medium">Scene background</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(
                [
                  { id: "video-loop", label: "Video loop" },
                  { id: "plain-white", label: "Plain white" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, backgroundPreset: opt.id }))}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    draft.backgroundPreset === opt.id
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "hover:bg-accent"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <VideoField
            label="Background loop"
            hint="Looping video behind every scene"
            value={draft.bgLoopUrl}
            busy={uploading === "bgLoopUrl"}
            onPick={(f) => void upload("bgLoopUrl", f)}
            onClear={() => setDraft((d) => ({ ...d, bgLoopUrl: null }))}
          />

          <VideoField
            label="Intro"
            hint="Opening clip added at the start of a part"
            value={draft.introUrl}
            busy={uploading === "introUrl"}
            onPick={(f) => void upload("introUrl", f)}
            onClear={() =>
              setDraft((d) => ({ ...d, introUrl: null, introDurationMs: null }))
            }
          />

          <VideoField
            label="Outro"
            hint="Closing clip added at the end of a part"
            value={draft.outroUrl}
            busy={uploading === "outroUrl"}
            onPick={(f) => void upload("outroUrl", f)}
            onClear={() =>
              setDraft((d) => ({ ...d, outroUrl: null, outroDurationMs: null }))
            }
          />

          <div className="rounded-lg border bg-card p-3">
            <div className="text-sm font-medium">Default voice</div>
            <div className="mt-2 space-y-2">
              {VOICE_ENGINE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, voiceEngine: opt.id }))}
                  className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                    effectiveVoice === opt.id
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "hover:bg-accent"
                  }`}
                >
                  <span>
                    <span className="font-medium">{opt.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {opt.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || uploading != null}
            onClick={() => void handleSave()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Save settings
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
