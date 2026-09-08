import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { apiListReviews, apiSaveReview } from "@/lib/reviews-api";

const OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "Under progress" },
  { value: "waiting_for_review", label: "Waiting for review" },
  { value: "approved", label: "Approved" },
] as const;

const VALUE_CLASSES: Record<string, string> = {
  pending: "border-border bg-muted text-muted-foreground",
  in_progress: "border-sky-500/40 bg-sky-500/15 text-sky-900",
  waiting_for_review: "border-amber-500/40 bg-amber-500/15 text-amber-900",
  approved: "border-emerald-600/40 bg-emerald-500/15 text-emerald-800",
};

/**
 * Per-part progress dropdown shown on the Script tab. Visible to everyone who
 * can open the part; the assigned composer and the episode reviewer (and
 * admins) can change it — the server enforces that.
 */
export function PartProgressStatus({
  projectId,
  partId,
  courseId,
}: {
  projectId: string;
  partId: string;
  courseId: string | null;
}) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: reviews } = useQuery({
    queryKey: ["reviews", courseId],
    queryFn: () => apiListReviews(courseId!),
    enabled: !!courseId,
    staleTime: 15_000,
  });

  const row = reviews?.find(
    (r) => r.project_id === projectId && r.part_id === partId,
  );
  const value =
    row && OPTIONS.some((o) => o.value === row.progress_status)
      ? row.progress_status
      : "pending";

  async function change(next: string) {
    if (next === value || saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiSaveReview({
        projectId,
        partId,
        courseId: courseId ?? undefined,
        progress_status: next,
      });
      await qc.invalidateQueries({ queryKey: ["reviews"] });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save status");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs font-medium text-muted-foreground">
        Part status
      </label>
      <div className="flex items-center gap-1.5">
        <select
          value={value}
          disabled={saving || !courseId}
          onChange={(e) => void change(e.target.value)}
          className={`h-8 rounded-md border px-2 text-xs font-medium ${VALUE_CLASSES[value] ?? VALUE_CLASSES.pending}`}
        >
          {OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {saving && (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        )}
      </div>
      {row?.updated_by_email && (
        <span className="text-[11px] text-muted-foreground">
          last update by {row.updated_by_email}
        </span>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
