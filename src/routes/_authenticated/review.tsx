import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, ClipboardCheck } from "lucide-react";
import { NavBar } from "@/components/NavBar";
import { apiListCourses, type CourseListItem } from "@/lib/courses-api";
import { apiListProjects, type ProjectListItem } from "@/lib/projects-api";
import {
  apiListReviews,
  apiSaveReview,
  type EpisodeReview,
} from "@/lib/reviews-api";

export const Route = createFileRoute("/_authenticated/review")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Review — Explainer Studio" },
      {
        name: "description",
        content:
          "Shared episode review sheet: review status, issues found, corrections and render tracking for every episode.",
      },
    ],
  }),
  component: ReviewPage,
});

const REVIEW_STATUS_OPTIONS = ["", "In progress", "Completed"];
const CORRECTION_STATUS_OPTIONS = ["", "pending", "In progress", "Completed"];
const RENDERED_OPTIONS = ["", "yes", "no"];

function episodeOrder(a: ProjectListItem, b: ProjectListItem): number {
  const num = (t: string) => {
    const m = t.match(/(\d+)/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  const d = num(a.title) - num(b.title);
  if (d !== 0 && Number.isFinite(d)) return d;
  return a.title.localeCompare(b.title);
}

function emptyReview(projectId: string, courseId: string): EpisodeReview {
  return {
    project_id: projectId,
    course_id: courseId,
    parts_checked: "",
    review_status: "",
    issues_found: "",
    correction_status: "",
    assignee_email: "",
    rendered_uploaded: "",
    updated_by_email: null,
    updated_at: "",
  };
}

function statusChipClass(kind: "review" | "correction" | "rendered", value: string) {
  const v = value.trim().toLowerCase();
  if (kind === "rendered") {
    if (v === "yes") return "bg-green-600 text-white";
    if (v === "no") return "bg-red-600 text-white";
    return "bg-muted text-muted-foreground";
  }
  if (v === "completed") return "bg-amber-200 text-amber-900";
  if (v === "pending") return "bg-red-600 text-white";
  if (v === "in progress") return "bg-blue-200 text-blue-900";
  return "bg-muted text-muted-foreground";
}

const POLL_MS = 10_000;

function ReviewPage() {
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [courseId, setCourseId] = useState("");
  const [episodes, setEpisodes] = useState<ProjectListItem[]>([]);
  const [reviews, setReviews] = useState<Record<string, EpisodeReview>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);

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
      // Don't clobber a cell the user is actively editing.
      if (silent && tableRef.current?.contains(document.activeElement)) return;
      if (!silent) setLoading(true);
      try {
        const [eps, revs] = await Promise.all([
          apiListProjects({ courseId }),
          apiListReviews(courseId),
        ]);
        setEpisodes([...eps].sort(episodeOrder));
        const map: Record<string, EpisodeReview> = {};
        for (const r of revs) map[r.project_id] = r;
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

  /** Known people: part assignees + review assignees in this course. */
  const knownAssignees = useMemo(() => {
    const set = new Set<string>();
    for (const ep of episodes) {
      for (const p of ep.parts_summary ?? []) {
        if (p.assigned_user_email) set.add(p.assigned_user_email);
      }
      if (ep.assigned_user_email) set.add(ep.assigned_user_email);
    }
    for (const r of Object.values(reviews)) {
      if (r.assignee_email) set.add(r.assignee_email);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [episodes, reviews]);

  function reviewFor(ep: ProjectListItem): EpisodeReview {
    return reviews[ep.id] ?? emptyReview(ep.id, courseId);
  }

  async function save(ep: ProjectListItem, patch: Partial<EpisodeReview>) {
    const current = reviewFor(ep);
    const next: EpisodeReview = { ...current, ...patch };
    setReviews((prev) => ({ ...prev, [ep.id]: next }));
    setSavingId(ep.id);
    setError(null);
    try {
      const saved = await apiSaveReview({
        projectId: ep.id,
        courseId,
        parts_checked: next.parts_checked,
        review_status: next.review_status,
        issues_found: next.issues_found,
        correction_status: next.correction_status,
        assignee_email: next.assignee_email,
        rendered_uploaded: next.rendered_uploaded,
      });
      setReviews((prev) => ({ ...prev, [ep.id]: saved }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save review");
    } finally {
      setSavingId(null);
    }
  }

  const selectCls =
    "h-8 w-full min-w-0 rounded-md border px-2 text-xs font-medium";
  const inputCls =
    "h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs";

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 xl:px-8">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ClipboardCheck size={20} className="text-primary" />
            Episode Video Review &amp; Correction Notes
          </h1>
          <span className="text-xs text-muted-foreground">
            Shared live sheet — everyone signed in sees the same data.
            {lastSync &&
              ` Last synced ${lastSync.toLocaleTimeString()}.`}
          </span>
          <button
            type="button"
            onClick={() => void load(false)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
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

        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        <div ref={tableRef} className="overflow-x-auto rounded-lg border">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="w-44 border-r px-3 py-2 font-medium">Episode</th>
                <th className="w-20 border-r px-3 py-2 font-medium">
                  Total Parts
                </th>
                <th className="w-36 border-r px-3 py-2 font-medium">
                  Parts Checked
                </th>
                <th className="w-32 border-r px-3 py-2 font-medium">
                  Review Status
                </th>
                <th className="min-w-[280px] border-r px-3 py-2 font-medium">
                  Issues Found
                </th>
                <th className="w-36 border-r px-3 py-2 font-medium">
                  Correction Status
                </th>
                <th className="w-44 border-r px-3 py-2 font-medium">
                  Assignment
                </th>
                <th className="w-32 px-3 py-2 font-medium">
                  Rendered &amp; Uploaded
                </th>
              </tr>
            </thead>
            <tbody>
              {episodes.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-6 text-sm text-muted-foreground"
                  >
                    No episodes in this course.
                  </td>
                </tr>
              ) : (
                episodes.map((ep) => {
                  const r = reviewFor(ep);
                  const partCount =
                    ep.part_count ?? ep.parts_summary?.length ?? 0;
                  const partsLabel =
                    ep.parts_summary && ep.parts_summary.length > 0
                      ? `Parts ${ep.parts_summary.map((_, i) => i + 1).join(", ")}`
                      : "—";
                  const busy = savingId === ep.id;
                  return (
                    <tr key={ep.id} className="border-b align-top">
                      <td className="border-r px-3 py-2 font-medium">
                        {ep.title}
                        {busy && (
                          <Loader2
                            size={12}
                            className="ml-1 inline animate-spin text-muted-foreground"
                          />
                        )}
                      </td>
                      <td className="border-r px-3 py-2 tabular-nums text-muted-foreground">
                        <div>{partCount}</div>
                        <div className="text-[10px]">{partsLabel}</div>
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <input
                          defaultValue={r.parts_checked}
                          key={`pc-${ep.id}-${r.updated_at}`}
                          placeholder={partsLabel !== "—" ? partsLabel : "Parts 1–4"}
                          onBlur={(e) => {
                            if (e.target.value !== r.parts_checked) {
                              void save(ep, { parts_checked: e.target.value });
                            }
                          }}
                          className={inputCls}
                        />
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <select
                          value={r.review_status}
                          onChange={(e) =>
                            void save(ep, { review_status: e.target.value })
                          }
                          className={`${selectCls} ${statusChipClass("review", r.review_status)}`}
                        >
                          {REVIEW_STATUS_OPTIONS.map((o) => (
                            <option key={o} value={o}>
                              {o || "—"}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <textarea
                          defaultValue={r.issues_found}
                          key={`if-${ep.id}-${r.updated_at}`}
                          placeholder="No issues found"
                          rows={2}
                          onBlur={(e) => {
                            if (e.target.value !== r.issues_found) {
                              void save(ep, { issues_found: e.target.value });
                            }
                          }}
                          className="w-full min-w-0 resize-y rounded-md border bg-background px-2 py-1.5 text-xs"
                        />
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <select
                          value={r.correction_status}
                          onChange={(e) =>
                            void save(ep, { correction_status: e.target.value })
                          }
                          className={`${selectCls} ${statusChipClass("correction", r.correction_status)}`}
                        >
                          {CORRECTION_STATUS_OPTIONS.map((o) => (
                            <option key={o} value={o}>
                              {o || "—"}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <input
                          defaultValue={r.assignee_email}
                          key={`as-${ep.id}-${r.updated_at}`}
                          placeholder="Unassigned"
                          list="review-assignees"
                          onBlur={(e) => {
                            if (e.target.value !== r.assignee_email) {
                              void save(ep, { assignee_email: e.target.value });
                            }
                          }}
                          className={inputCls}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <select
                          value={r.rendered_uploaded}
                          onChange={(e) =>
                            void save(ep, { rendered_uploaded: e.target.value })
                          }
                          className={`${selectCls} ${statusChipClass("rendered", r.rendered_uploaded)}`}
                        >
                          {RENDERED_OPTIONS.map((o) => (
                            <option key={o} value={o}>
                              {o || "—"}
                            </option>
                          ))}
                        </select>
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
