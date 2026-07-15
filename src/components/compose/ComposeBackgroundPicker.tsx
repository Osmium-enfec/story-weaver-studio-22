import { Film, Square } from "lucide-react";
import {
  COMPOSE_BACKGROUND_PRESETS,
  type ComposeBackgroundPreset,
} from "@/lib/compose-background";

export function ComposeBackgroundPicker({
  value,
  onChange,
}: {
  value: ComposeBackgroundPreset;
  onChange: (preset: ComposeBackgroundPreset) => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground">Scene background</div>
      <div className="flex flex-wrap gap-2">
        {COMPOSE_BACKGROUND_PRESETS.map((preset) => {
          const active = value === preset.id;
          const Icon = preset.id === "video-loop" ? Film : Square;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onChange(preset.id)}
              className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition ${
                active
                  ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                  : "hover:bg-accent"
              }`}
            >
              <Icon size={14} className="shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium">{preset.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{preset.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
