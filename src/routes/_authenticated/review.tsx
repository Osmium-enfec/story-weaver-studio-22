import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  RefreshCw,
  ClipboardCheck,
  Lock,
  Upload,
  FileText,
} from "lucide-react";
import { apiPersistAssetFile } from "@/lib/compose-api";
import { NavBar } from "@/components/NavBar";
import { apiListCourses, type CourseListItem } from "@/lib/courses-api";
import {
  apiListProjects,
  type ProjectListItem,
  type ProjectPartSummary,
} from "@/lib/projects-api";
import {
  apiListReviews,
  apiSaveReview,
  apiReviewGrants,
  type PartReview,
} from "@/lib/reviews-api";
import { ReviewStageBadge } from "@/components/ReviewStageBadge";
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
      { title: "Review — Div Studio" },
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
    review_doc_url: "",
    review_doc_name: "",
    rendered_uploaded: "",
    workflow_status: "",
    workflow_by_email: "",
    workflow_at: "",
    progress_status: "pending",
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

const PAGE_SIZE = 10;

function ReviewPage() {
  const qc = useQueryClient();
  const [courseId, setCourseId] = useState("");
  const [overrides, setOverrides] = useState<Record<string, PartReview>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [grantedFields, setGrantedFields] = useState<ReviewField[] | null>(
    null,
  );
  const tableRef = useRef<HTMLDivElement | null>(null);
  const [onlyMyReviews, setOnlyMyReviews] = useState(false);
  const [page, setPage] = useState(1);

  const session = typeof window !== "undefined" ? getStoredSession() : null;
  const myEmail = session?.user.email ?? "";
  const isAdmin = session?.user.isAdmin === true || isAdminEmail(myEmail);

  useEffect(() => {
    apiReviewGrants()
      .then((g) =>
        setGrantedFields(g.fields ? (g.fields as ReviewField[]) : null),
      )
      .catch(() => setGrantedFields(null));
  }, []);

  const coursesQuery = useQuery({
    queryKey: ["courses"],
    queryFn: () => apiListCourses(),
    staleTime: 5 * 60_000,
  });
  const courses: CourseListItem[] = coursesQuery.data ?? [];

  useEffect(() => {
    if (!courseId && courses[0]) setCourseId(courses[0].id);
  }, [courses, courseId]);

  // Pause background refreshes while the tab is hidden or a cell has focus.
  const liveRefetch = () =>
    typeof document !== "undefined" &&
    (document.hidden || tableRef.current?.contains(document.activeElement))
      ? false
      : POLL_MS;

  const episodesQuery = useQuery({
    queryKey: ["projects", "course", courseId, "page", page],
    queryFn: () =>
      apiListProjects({
        courseId,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
    enabled: !!courseId,
    placeholderData: (prev) => prev,
    staleTime: POLL_MS,
    refetchInterval: liveRefetch,
  });

  const reviewsQuery = useQuery({
    queryKey: ["reviews", courseId],
    queryFn: () => apiListReviews(courseId),
    enabled: !!courseId,
    staleTime: POLL_MS,
    refetchInterval: liveRefetch,
  });

  const loading = episodesQuery.isPending || reviewsQuery.isPending;
  const loadError = episodesQuery.error ?? reviewsQuery.error;
  const lastSync = episodesQuery.dataUpdatedAt
    ? new Date(episodesQuery.dataUpdatedAt)
    : null;

  const pagedEpisodes = useMemo(
    () => [...(episodesQuery.data ?? [])].sort(episodeOrder),
    [episodesQuery.data],
  );

  const reviews: Record<string, PartReview> = useMemo(() => {
    const map: Record<string, PartReview> = {};
    for (const r of reviewsQuery.data ?? [])
      map[`${r.project_id}:${r.part_id}`] = r;
    return { ...map, ...overrides };
  }, [reviewsQuery.data, overrides]);

  useEffect(() => {
    setPage(1);
  }, [courseId, onlyMyReviews]);

  const totalEpisodes =
    courses.find((c) => c.id === courseId)?.episode_count ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalEpisodes / PAGE_SIZE));

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const me = myEmail.trim().toLowerCase();
    for (const ep of pagedEpisodes) {
      let parts = [...(ep.parts_summary ?? [])].sort(partOrder);
      if (onlyMyReviews) {
        parts = parts.filter((p) => {
          const isMine =
            (p.reviewer_user_email ?? "").trim().toLowerCase() === me && !!me;
          const status = reviews[`${ep.id}:${p.id}`]?.workflow_status ?? "";
          return isMine && status === "ready_for_review";
        });
      }
      parts.forEach((part, i) =>
        out.push({ episode: ep, part, index: i, count: parts.length }),
      );
    }
    return out;
  }, [pagedEpisodes, onlyMyReviews, reviews, myEmail]);

  const knownAssignees = useMemo(() => {
    const set = new Set<string>();
    for (const ep of pagedEpisodes) {
      for (const p of ep.parts_summary ?? []) {
        if (p.assigned_user_email) set.add(p.assigned_user_email);
      }
    }
    for (const r of Object.values(reviews)) {
      if (r.assignee_email) set.add(r.assignee_email);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [pagedEpisodes, reviews]);

  function reviewFor(row: Row): PartReview {
    return (
      reviews[`${row.episode.id}:${row.part.id}`] ??
      emptyReview(row.episode.id, row.part.id, courseId)
    );
  }

  function can(row: Row, field: ReviewField): boolean {
    return canEditReviewField(
      field,
      { email: myEmail, isAdmin, grantedFields },
      {
        composerEmail: row.part.assigned_user_email,
        reviewAssigneeEmail: reviewFor(row).assignee_email || null,
        reviewerEmail: row.part.reviewer_user_email ?? null,
      },
    );
  }

  async function save(row: Row, patch: Partial<PartReview>) {
    const key = `${row.episode.id}:${row.part.id}`;
    const current = reviewFor(row);
    const next: PartReview = { ...current, ...patch };
    setOverrides((prev) => ({ ...prev, [key]: next }));
    setSavingKey(key);
    setError(null);
    try {
      const saved = await apiSaveReview({
        projectId: row.episode.id,
        partId: row.part.id,
        courseId,
        ...(patch as Record<string, string>),
      });
      setOverrides((prev) => ({ ...prev, [key]: saved }));
      void qc.invalidateQueries({ queryKey: ["reviews", courseId] });
    } catch (e: unknown) {
      setOverrides((prev) => {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
      setError(e instanceof Error ? e.message : "Could not save review");
    } finally {
      setSavingKey(null);
    }
  }

  async function uploadDoc(row: Row, file: File) {
    const key = `${row.episode.id}:${row.part.id}`;
    setUploadingKey(key);
    setError(null);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "pdf";
      const url = await apiPersistAssetFile({
        file,
        projectId: row.episode.id,
        ext,
      });
      await save(row, { review_doc_url: url, review_doc_name: file.name });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not upload document");
    } finally {
      setUploadingKey(null);
    }
  }

  const selectCls =
    "h-8 w-full min-w-0 rounded-md border px-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60";
  const inputCls =
    "h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60";

  function DocCell({ row }: { row: Row }) {
    const r = reviewFor(row);
    const editable = can(row, "review_doc");
    const key = `${row.episode.id}:${row.part.id}`;
    const uploading = uploadingKey === key;
    return (
      <div className="flex flex-col gap-1">
        {r.review_doc_url ? (
          <a
            href={r.review_doc_url}
            download={r.review_doc_name || undefined}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 truncate text-xs text-primary underline"
            title={r.review_doc_name || "Download document"}
          >
            <FileText size={12} className="shrink-0" />
            <span className="truncate">{r.review_doc_name || "Document"}</span>
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">No document</span>
        )}
        {editable && (
          <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            {uploading ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Upload size={11} />
            )}
            {uploading
              ? "Uploading…"
              : r.review_doc_url
                ? "Replace"
                : "Upload"}
            <input
              type="file"
              className="hidden"
              disabled={uploading}
              accept=".pdf,.doc,.docx,.txt,.rtf,.xls,.xlsx,.ppt,.pptx,.csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadDoc(row, file);
              }}
            />
          </label>
        )}
      </div>
    );
  }

  function StatusCell({
    row,
    field,
    options,
    kind,
  }: {
    row: Row;
    field: Exclude<ReviewField, "review_doc">;
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
            onClick={() => {
              void episodesQuery.refetch();
              void reviewsQuery.refetch();
            }}
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
          <label className="ml-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={onlyMyReviews}
              onChange={(e) => setOnlyMyReviews(e.target.checked)}
              className="rounded border"
            />
            Only parts waiting for my review
          </label>
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

        {(error || loadError) && (
          <p className="mb-3 text-sm text-destructive">
            {error ??
              (loadError instanceof Error
                ? loadError.message
                : String(loadError))}
          </p>
        )}

        <div ref={tableRef} className="overflow-x-auto rounded-lg border">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="w-32 border-r px-3 py-2 font-medium">Episode</th>
                <th className="w-28 border-r px-3 py-2 font-medium">Part</th>
                <th className="w-40 border-r px-3 py-2 font-medium">Stage</th>
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
                  Document
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
                    colSpan={12}
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
                      <td className="border-r px-3 py-2">
                        <ReviewStageBadge
                          status={r.workflow_status}
                          by={r.workflow_by_email}
                          at={r.workflow_at}
                        />
                        {!r.workflow_status && (
                          <span className="text-[10px] text-muted-foreground">
                            —
                          </span>
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
                        <DocCell row={row} />
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

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            Showing episodes{" "}
            {totalEpisodes === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–
            {Math.min(page * PAGE_SIZE, totalEpisodes)} of {totalEpisodes}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-md border px-2.5 py-1 hover:bg-accent disabled:opacity-50"
            >
              Previous
            </button>
            {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPage(p)}
                className={`rounded-md border px-2.5 py-1 ${p === page ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              >
                {p}
              </button>
            ))}
            <button
              type="button"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              className="rounded-md border px-2.5 py-1 hover:bg-accent disabled:opacity-50"
            >
              Next
            </button>
          </div>
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
