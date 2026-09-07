/** Shared labels/colours for the part review workflow. */

export type WorkflowStatus = "" | "ready_for_review" | "reviewed" | "redo";

export function normalizeWorkflowStatus(value: unknown): WorkflowStatus {
  const v = String(value ?? "").trim();
  return v === "ready_for_review" || v === "reviewed" || v === "redo" ? v : "";
}

export function workflowLabel(status: WorkflowStatus): string {
  switch (status) {
    case "ready_for_review":
      return "Ready for review";
    case "reviewed":
      return "Reviewed — ready for download";
    case "redo":
      return "Redo";
    default:
      return "Not sent for review";
  }
}

export function workflowShortLabel(status: WorkflowStatus): string {
  return status === "reviewed" ? "Reviewed" : workflowLabel(status);
}

export function workflowClasses(status: WorkflowStatus): string {
  switch (status) {
    case "ready_for_review":
      return "border-amber-500/40 bg-amber-500/15 text-amber-900";
    case "reviewed":
      return "border-emerald-600/40 bg-emerald-500/15 text-emerald-800";
    case "redo":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}
