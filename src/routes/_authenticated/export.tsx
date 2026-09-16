import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { NavBar } from "@/components/NavBar";
import { apiListCourses } from "@/lib/courses-api";
import {
  apiDeleteRenderJob,
  apiDeleteRenderVideo,
  apiListRenderJobs,
  apiRequeueRenderJob,
  apiStopRenderJob,
  type RenderJobItem,
} from "@/lib/render-jobs-api";
import { getStoredSession } from "@/lib/auth-client";

export const Route = createFileRoute("/_authenticated/export")({
  head: () => ({
    meta: [
      { title: "HD renders — Div Studio" },
      {
        name: "description",
        content:
          "Queue reviewed parts for HD rendering, watch live progress and download finished videos.",
      },
      { property: "og:title", content: "HD renders — Div Studio" },
      {
        property: "og:description",
        content: "Queue, track and download HD renders for every course part.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ExportPage,
});

type TabId = "queued" | "progress" | "rendered";

const TABS: { id: TabId; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "progress", label: "In progress" },
  { id: "rendered", label: "Rendered" },
];

const PAGE_SIZE = 10;

function matchesTab(job: RenderJobItem, tab: TabId): boolean {
  if (tab === "queued") return job.status === "queued" || job.status === "cancelled";
  if (tab === "progress") return job.status === "rendering";
  return job.status === "done" || job.status === "failed";
}

function fmtDuration(ms: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function fmtElapsed(from: string | null): string {
  if (!from) return "—";
  const start = new Date(from).getTime();
  if (!Number.isFinite(start)) return "—";
  return fmtDuration(Date.now() - start);
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
}

function ExportPage() {
  const qc = useQueryClient();
  const session = getStoredSession();
  const isAdmin = session?.user.isAdmin ?? false;

  const [courseId, setCourseId] = useState<string>("all");
  const [tab, setTab] = useState<TabId>("queued");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const coursesQuery = useQuery({
    queryKey: ["courses"],
    queryFn: apiListCourses,
    staleTime: 5 * 60_000,
  });

  const jobsQuery = useQuery({
    queryKey: ["render-jobs", courseId],
    queryFn: () =>
      apiListRenderJobs(courseId === "all" ? undefined : { courseId }),
    refetchInterval: 4000,
  });

  const jobs = jobsQuery.data?.jobs ?? [];

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["render-jobs"] });

  const stopJob = useMutation({
    mutationFn: apiStopRenderJob,
    onSuccess: invalidate,
    onError: (e: Error) => alert(e.message),
  });
  const deleteJob = useMutation({
    mutationFn: apiDeleteRenderJob,
    onSuccess: invalidate,
    onError: (e: Error) => alert(e.message),
  });
  const deleteVideo = useMutation({
    mutationFn: apiDeleteRenderVideo,
    onSuccess: invalidate,
    onError: (e: Error) => alert(e.message),
  });
  const requeueJob = useMutation({
    mutationFn: apiRequeueRenderJob,
    onSuccess: invalidate,
    onError: (e: Error) => alert(e.message),
  });

  const tabJobs = useMemo(() => jobs.filter((j) => matchesTab(j, tab)), [jobs, tab]);

  const episodes = useMemo(() => {
    const byEpisode = new Map<
      string,
      { projectId: string; title: string; jobs: RenderJobItem[] }
    >();
    for (const job of tabJobs) {
      const entry = byEpisode.get(job.projectId) ?? {
        projectId: job.projectId,
        title: job.episodeTitle || "Episode",
        jobs: [],
      };
      entry.jobs.push(job);
      byEpisode.set(job.projectId, entry);
    }
    return [...byEpisode.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [tabJobs]);

  const pageCount = Math.max(1, Math.ceil(episodes.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = episodes.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  const activeMachines = [
    ...new Set(
      jobs.filter((j) => j.status === "rendering" && j.machine).map((j) => j.machine!),
    ),
  ];

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">HD renders</h1>
            <p className="text-sm text-muted-foreground">
              Reviewed parts queue here; render machines pick them up one by one.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>
              <strong className="text-foreground">{queuedCount}</strong> waiting
            </span>
            <span>
              <strong className="text-foreground">{activeMachines.length}</strong>{" "}
              machine(s) rendering
              {activeMachines.length > 0 && `: ${activeMachines.join(", ")}`}
            </span>
          </div>
        </header>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <select
            value={courseId}
            onChange={(e) => {
              setCourseId(e.target.value);
              setPage(1);
            }}
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="all">All courses</option>
            {(coursesQuery.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>

          <div className="flex rounded-md border p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTab(t.id);
                  setPage(1);
                }}
                className={`rounded px-3 py-1.5 text-xs font-medium ${
                  tab === t.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {t.label} ({jobs.filter((j) => matchesTab(j, t.id)).length})
              </button>
            ))}
          </div>

          {jobsQuery.isFetching && (
            <Loader2 size={14} className="animate-spin text-muted-foreground" />
          )}
        </div>

        {visible.length === 0 ? (
          <p className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            Nothing here yet.
          </p>
        ) : (
          <div className="space-y-2">
            {visible.map((ep) => {
              const expanded = open[ep.projectId] ?? true;
              return (
                <section key={ep.projectId} className="rounded-lg border bg-card">
                  <button
                    type="button"
                    onClick={() =>
                      setOpen((o) => ({ ...o, [ep.projectId]: !expanded }))
                    }
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium"
                  >
                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    <span className="flex-1 truncate">{ep.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {ep.jobs.length} part{ep.jobs.length === 1 ? "" : "s"}
                    </span>
                  </button>

                  {expanded && (
                    <ul className="divide-y border-t">
                      {ep.jobs.map((job) => (
                        <li
                          key={job.id}
                          className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm"
                        >
                          <div className="min-w-[160px] flex-1">
                            <p className="truncate font-medium">{job.partTitle}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {job.sceneCount} scenes · {fmtDuration(job.durationMs)} ·{" "}
                              {job.requestedByEmail}
                            </p>
                          </div>

                          {job.status === "rendering" && (
                            <div className="min-w-[180px] flex-1">
                              <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                                <div
                                  className="h-full bg-primary transition-[width]"
                                  style={{
                                    width: `${Math.round((job.progress || 0) * 100)}%`,
                                  }}
                                />
                              </div>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {Math.round((job.progress || 0) * 100)}% ·{" "}
                                {job.stage || "rendering"} · {job.machine ?? "machine"} ·{" "}
                                {fmtElapsed(job.claimedAt)}
                              </p>
                            </div>
                          )}

                          {job.status !== "rendering" && (
                            <span
                              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                                job.status === "done"
                                  ? "bg-emerald-500/10 text-emerald-700"
                                  : job.status === "failed"
                                    ? "bg-destructive/10 text-destructive"
                                    : job.status === "cancelled"
                                      ? "bg-muted text-muted-foreground"
                                      : "bg-amber-500/10 text-amber-800"
                              }`}
                              title={job.error ?? undefined}
                            >
                              {job.status}
                            </span>
                          )}

                          <span className="text-[11px] text-muted-foreground">
                            {fmtDate(
                              job.status === "done" ? job.finishedAt : job.createdAt,
                            )}
                          </span>

                          <div className="flex items-center gap-1.5">
                            {job.outputUrl && (
                              <>
                                <a
                                  href={job.outputUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="Play"
                                  className="rounded border p-1.5 hover:bg-muted"
                                >
                                  <Play size={14} />
                                </a>
                                <a
                                  href={job.outputUrl}
                                  download
                                  title="Download"
                                  className="rounded border p-1.5 hover:bg-muted"
                                >
                                  <Download size={14} />
                                </a>
                                <button
                                  type="button"
                                  title="Copy link"
                                  onClick={() =>
                                    void navigator.clipboard.writeText(job.outputUrl!)
                                  }
                                  className="rounded border p-1.5 hover:bg-muted"
                                >
                                  <Copy size={14} />
                                </button>
                              </>
                            )}

                            {(job.status === "queued" || job.status === "rendering") && (
                              <button
                                type="button"
                                title="Stop"
                                onClick={() => stopJob.mutate(job.id)}
                                className="rounded border p-1.5 text-destructive hover:bg-destructive/10"
                              >
                                <Square size={14} />
                              </button>
                            )}

                            {job.status !== "rendering" && (
                              <button
                                type="button"
                                title="Re-queue"
                                onClick={() => requeueJob.mutate(job.id)}
                                className="rounded border p-1.5 hover:bg-muted"
                              >
                                <RotateCcw size={14} />
                              </button>
                            )}

                            {job.outputUrl && isAdmin && (
                              <button
                                type="button"
                                title="Delete rendered video (admin)"
                                onClick={() => {
                                  if (confirm("Remove this rendered video?")) {
                                    deleteVideo.mutate(job.id);
                                  }
                                }}
                                className="rounded border border-destructive/40 px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10"
                              >
                                Delete video
                              </button>
                            )}

                            <button
                              type="button"
                              title="Delete job"
                              onClick={() => {
                                if (confirm("Delete this render job?")) {
                                  deleteJob.mutate(job.id);
                                }
                              }}
                              className="rounded border p-1.5 text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {pageCount > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2 text-xs">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
              className="rounded border px-2 py-1 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-muted-foreground">
              Page {currentPage} of {pageCount}
            </span>
            <button
              type="button"
              disabled={currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
              className="rounded border px-2 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
