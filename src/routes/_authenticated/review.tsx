import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, ClipboardCheck, Lock } from "lucide-react";
import { NavBar } from "@/components/NavBar";
import { apiListCourses, type CourseListItem } from "@/lib/courses-api";
import {
  apiListProjects,
  type ProjectListItem,
  type ProjectPartSummary,
} from "@/lib/projects-api";
import { apiListReviews, apiSaveReview, type PartReview } from "@/lib/reviews-api";
import { getStoredSession } from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin";
import {
  canEditReviewField,
  type ReviewField,
} from "@/lib/review-permissions";

export const Route = createFileRoute("/_authenticated/review")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Review — Explainer Studio" },
      {
        name: "description",
        content:
          "Shared part-by-part review sheet: script, screen recording, composing, review status, issues, corrections and render tracking.",
      },
    ],
  }),
  component: ReviewPage,
});

const PROGRESS_OPTIONS = ["", "pending", "In progress", "Completed"];
const REVIEW_STATUS_OPTIONS = ["", "In progress", "Completed"];
const CORRECTION_STATUS_OPTIONS = ["", "pending", "In progress", "Completed"];
const RENDERED_OPTIONS = ["", "yes", "no"];

function episodeOrder(a: ProjectListItem, b: ProjectListItem): number {
  const num = (t: string) => {
    const m = t.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  const d = num(a.title) - num(b.title);
  if (d !== 0 && Number.isFinite(d)) return d;
  return a.title.localeCompare(b.title);
}

function partOrder(a: ProjectPartSummary, b: ProjectPartSummary): number {
  const num = (t: string) => {
    const m = t.match(/(\d+)/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  const d = num(a.title) - num(b.title);
  if (d !== 0 && Number.isFinite(d)) return d;
  return a.title.localeCompare(b.title);
}

function emptyReview(
  projectId: string,
  partId: string,
  courseId: string,
): PartReview {
  return {
    project_id: projectId,
    part_id: partId,
    course_id: courseId,
    script_status: "",
    recording_status: "",
    review_status: "",
    issues_found: "",
    correction_status: "",
    assignee_email: "",
    rendered_uploaded: "",
    updated_by_email: null,
    updated_at: "",
  };
}

function statusChipClass(
  kind: "progress" | "review" | "correction" | "rendered",
  value: string,
) {
  const v = value.trim().toLowerCase();
  if (kind === "rendered") {
    if (v === "yes") return "bg-green-600 text-white";
    if (v === "no") return "bg-red-600 text-white";
    return "bg-muted text-muted-foreground";
  }
  if (v === "completed") return "bg-green-200 text-green-900";
  if (v === "pending") return "bg-red-600 text-white";
  if (v === "in progress") return "bg-blue-200 text-blue-900";
  return "bg-muted text-muted-foreground";
}

const POLL_MS = 10_000;

type Row = {
  episode: ProjectListItem;
  part: ProjectPartSummary;
  index: number;
  count: number;
};

function ReviewPage() {
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [courseId, setCourseId] = useState("");
  const [episodes, setEpisodes] = useState<ProjectListItem[]>([]);
  const [reviews, setReviews] = useState<Record<string, PartReview>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);

  const session = typeof window !== "undefined" ? getStoredSession() : null;
  const myEmail = session?.user.email ?? "";
  const isAdmin = session?.user.isAdmin === true || isAdminEmail(myEmail);

  useEffect(() => {
    apiListCourses()
      .then((list) => {
        setCourses(list);
        if (list[0]) setCourseId((prev) => prev || list[0].id);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  const load = useCallback(
    async (silent: boolean) => {
      if (!courseId) return;
      if (silent && tableRef.current?.contains(document.activeElement)) return;
      if (!silent) setLoading(true);
      try {
        const [eps, revs] = await Promise.all([
          apiListProjects({ courseId }),
          apiListReviews(courseId),
        ]);
        setEpisodes([...eps].sort(episodeOrder));
        const map: Record<string, PartReview> = {};
        for (const r of revs) map[`${r.project_id}:${r.part_id}`] = r;
        setReviews(map);
        setError(null);
        setLastSync(new Date());
      } catch (e: unknown) {
        if (!silent) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [courseId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const ep of episodes) {
      const parts = [...(ep.parts_summary ?? [])].sort(partOrder);
      parts.forEach((part, i) =>
        out.push({ episode: ep, part, index: i, count: parts.length }),
      );
    }
    return out;
  }, [episodes]);

  const knownAssignees = useMemo(() => {
    const set = new Set<string>();
    for (const ep of episodes) {
      for (const p of ep.parts_summary ?? []) {
        if (p.assigned_user_email) set.add(p.assigned_user_email);
      }
    }
    for (const r of Object.values(reviews)) {
      if (r.assignee_email) set.add(r.assignee_email);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [episodes, reviews]);

  function reviewFor(row: Row): PartReview {
    return (
      reviews[`${row.episode.id}:${row.part.id}`] ??
      emptyReview(row.episode.id, row.part.id, courseId)
    );
  }

  function can(row: Row, field: ReviewField): boolean {
    return canEditReviewField(
      field,
      { email: myEmail, isAdmin },
      {
        composerEmail: row.part.assigned_user_email,
        reviewAssigneeEmail: reviewFor(row).assignee_email || null,
      },
    );
  }

  async function save(row: Row, patch: Partial<PartReview>) {
    const key = `${row.episode.id}:${row.part.id}`;
    const current = reviewFor(row);
    const next: PartReview = { ...current, ...patch };
    setReviews((prev) => ({ ...prev, [key]: next }));
    setSavingKey(key);
    setError(null);
    try {
      const saved = await apiSaveReview({
        projectId: row.episode.id,
        partId: row.part.id,
        courseId,
        ...(patch as Record<string, string>),
      });
      setReviews((prev) => ({ ...prev, [key]: saved }));
    } catch (e: unknown) {
      setReviews((prev) => ({ ...prev, [key]: current }));
      setError(e instanceof Error ? e.message : "Could not save review");
    } finally {
      setSavingKey(null);
    }
  }

  const selectCls =
    "h-8 w-full min-w-0 rounded-md border px-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60";
  const inputCls =
    "h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60";

  function StatusCell({
    row,
    field,
    options,
    kind,
  }: {
    row: Row;
    field: ReviewField;
    options: string[];
    kind: "progress" | "review" | "correction" | "rendered";
  }) {
    const r = reviewFor(row);
    const value = (r[field] as string) ?? "";
    const editable = can(row, field);
    return (
      <select
        value={value}
        disabled={!editable}
        title={editable ? undefined : "You don't have access to edit this column"}
        onChange={(e) => void save(row, { [field]: e.target.value } as Partial<PartReview>)}
        className={`${selectCls} ${statusChipClass(kind, value)}`}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o || "—"}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <main className="mx-auto w-full max-w-[1800px] px-4 py-6 xl:px-8">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ClipboardCheck size={20} className="text-primary" />
            Episode Production &amp; Review Sheet
          </h1>
          <span className="text-xs text-muted-foreground">
            Shared live sheet — one row per part.
            {lastSync && ` Last synced ${lastSync.toLocaleTimeString()}.`}
          </span>
          <button
            type="button"
            onClick={() => void load(false)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            Course
          </label>
          <select
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
            className="h-9 min-w-[16rem] rounded-md border bg-background px-2 text-sm"
          >
            {courses.length === 0 && <option value="">No courses</option>}
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} ({c.episode_count})
              </option>
            ))}
          </select>
          {loading && (
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          )}
        </div>

        <p className="mb-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Lock size={11} />
          Script &amp; recording: the part's assigned editor. Review status
          &amp; issues: the reviewer. Correction status: the assigned person.
          Rendered &amp; uploaded: admin only. Admins can edit everything.
        </p>

        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        <div ref={tableRef} className="overflow-x-auto rounded-lg border">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="w-32 border-r px-3 py-2 font-medium">Episode</th>
                <th className="w-28 border-r px-3 py-2 font-medium">Part</th>
                <th className="w-32 border-r px-3 py-2 font-medium">Script</th>
                <th className="w-36 border-r px-3 py-2 font-medium">
                  Screen Recording
                </th>
                <th className="w-44 border-r px-3 py-2 font-medium">
                  Composing (assigned)
                </th>
                <th className="w-32 border-r px-3 py-2 font-medium">
                  Review Status
                </th>
                <th className="min-w-[280px] border-r px-3 py-2 font-medium">
                  Issues Found
                </th>
                <th className="w-44 border-r px-3 py-2 font-medium">
                  Review Assignment
                </th>
                <th className="w-36 border-r px-3 py-2 font-medium">
                  Correction Status
                </th>
                <th className="w-32 px-3 py-2 font-medium">
                  Rendered &amp; Uploaded
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={10}
                    className="px-3 py-6 text-sm text-muted-foreground"
                  >
                    No episode parts in this course.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const r = reviewFor(row);
                  const key = `${row.episode.id}:${row.part.id}`;
                  const busy = savingKey === key;
                  const canIssues = can(row, "issues_found");
                  const canAssign = can(row, "assignee_email");
                  return (
                    <tr key={key} className="border-b align-top">
                      {row.index === 0 && (
                        <td
                          rowSpan={row.count}
                          className="border-r px-3 py-2 font-medium"
                        >
                          {row.episode.title}
                          <div className="text-[10px] font-normal text-muted-foreground">
                            {row.count} part{row.count === 1 ? "" : "s"}
                          </div>
                        </td>
                      )}
                      <td className="border-r px-3 py-2 text-xs font-medium">
                        {row.part.title}
                        {busy && (
                          <Loader2
                            size={12}
                            className="ml-1 inline animate-spin text-muted-foreground"
                          />
                        )}
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <StatusCell
                          row={row}
                          field="script_status"
                          options={PROGRESS_OPTIONS}
                          kind="progress"
                        />
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <StatusCell
                          row={row}
                          field="recording_status"
                          options={PROGRESS_OPTIONS}
                          kind="progress"
                        />
                      </td>
                      <td className="border-r px-3 py-2 text-xs text-muted-foreground">
                        {row.part.assigned_user_email || "Unassigned"}
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <StatusCell
                          row={row}
                          field="review_status"
                          options={REVIEW_STATUS_OPTIONS}
                          kind="review"
                        />
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <textarea
                          defaultValue={r.issues_found}
                          key={`if-${key}-${r.updated_at}`}
                          disabled={!canIssues}
                          placeholder={
                            canIssues
                              ? "Shift+Enter for a new issue line…"
                              : "No issues found"
                          }
                          rows={2}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              e.currentTarget.blur();
                            }
                          }}
                          onBlur={(e) => {
                            if (e.target.value !== r.issues_found) {
                              void save(row, { issues_found: e.target.value });
                            }
                          }}
                          className="w-full min-w-0 resize-y rounded-md border bg-background px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <input
                          defaultValue={r.assignee_email}
                          key={`as-${key}-${r.updated_at}`}
                          disabled={!canAssign}
                          placeholder="Unassigned"
                          list="review-assignees"
                          onBlur={(e) => {
                            if (e.target.value !== r.assignee_email) {
                              void save(row, { assignee_email: e.target.value });
                            }
                          }}
                          className={inputCls}
                        />
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <StatusCell
                          row={row}
                          field="correction_status"
                          options={CORRECTION_STATUS_OPTIONS}
                          kind="correction"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <StatusCell
                          row={row}
                          field="rendered_uploaded"
                          options={RENDERED_OPTIONS}
                          kind="rendered"
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <datalist id="review-assignees">
          {knownAssignees.map((email) => (
            <option key={email} value={email} />
          ))}
        </datalist>
      </main>
    </div>
  );
}
