import { Loader2, RotateCcw } from "lucide-react";
import type { RetryableStep, WorkshopStep } from "@/lib/scene-workshop-steps";
import { RETRYABLE_STEPS } from "@/lib/scene-workshop-steps";

export function SceneStepPanel({
  steps,
  running,
  runningStep,
  onRetry,
}: {
  steps: WorkshopStep[];
  running: boolean;
  runningStep: RetryableStep | "full" | null;
  onRetry: (step: RetryableStep) => void;
}) {
  if (steps.length === 0) return null;

  const stepColor = (s: WorkshopStep) => {
    if (s.status === "ok") return "bg-green-50 text-green-700 border-green-200";
    if (s.status === "warn") return "bg-amber-50 text-amber-700 border-amber-200";
    if (s.status === "error") return "bg-red-50 text-red-700 border-red-200";
    return "bg-muted text-muted-foreground border-border";
  };

  const stepIcon = (s: WorkshopStep) =>
    s.status === "ok" ? "✓" : s.status === "warn" ? "!" : s.status === "error" ? "✕" : "…";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {steps.map((s, k) => (
          <span
            key={`${s.name}-${k}`}
            title={s.message || ""}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${stepColor(s)}`}
          >
            <span className="font-mono">{stepIcon(s)}</span>
            <span>{s.name}</span>
            {s.message && (
              <span className="max-w-[220px] truncate opacity-75">· {s.message}</span>
            )}
          </span>
        ))}
      </div>

      {!running && (
        <div className="flex flex-wrap gap-2">
          {RETRYABLE_STEPS.map((def) => (
            <button
              key={def.id}
              type="button"
              onClick={() => onRetry(def.id)}
              disabled={runningStep === def.id}
              className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {runningStep === def.id ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RotateCcw size={12} />
              )}
              Retry {def.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
