import {
  normalizeWorkflowStatus,
  workflowClasses,
  workflowShortLabel,
  type WorkflowStatus,
} from "@/lib/review-workflow";

export function ReviewStageBadge({
  status,
  by,
  at,
  className = "",
}: {
  status: WorkflowStatus | string | null | undefined;
  by?: string | null;
  at?: string | null;
  className?: string;
}) {
  const s = normalizeWorkflowStatus(status);
  if (!s) return null;
  const when = at ? new Date(at) : null;
  const title = [
    by ? `By ${by}` : null,
    when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      title={title || undefined}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${workflowClasses(
        s,
      )} ${className}`}
    >
      {workflowShortLabel(s)}
    </span>
  );
}
