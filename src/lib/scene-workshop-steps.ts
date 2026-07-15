export type StepStatus = "running" | "ok" | "warn" | "error";

export interface WorkshopStep {
  name: string;
  status: StepStatus;
  message?: string;
}

/** Steps the user can retry individually in the workshop. */
export type RetryableStep =
  | "composite"
  | "tts"
  | "boxes"
  | "box-label"
  | "reveal-sync";

export const RETRYABLE_STEPS: { id: RetryableStep; label: string; depends: string[] }[] = [
  { id: "composite", label: "Composite image", depends: ["composite"] },
  { id: "tts", label: "Narration (TTS)", depends: ["tts"] },
  { id: "boxes", label: "Detect boxes", depends: ["reveal-analyze"] },
  { id: "box-label", label: "Label boxes", depends: ["box-label"] },
  { id: "reveal-sync", label: "Sync to speech", depends: ["reveal-sync"] },
];

export function upsertStep(steps: WorkshopStep[], step: WorkshopStep): WorkshopStep[] {
  const next = [...steps];
  const idx = next.findIndex((s) => s.name === step.name && s.status === "running");
  if (idx >= 0) next[idx] = step;
  else next.push(step);
  return next;
}
