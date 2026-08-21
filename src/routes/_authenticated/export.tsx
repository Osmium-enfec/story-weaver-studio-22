import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, Film, CheckCircle2, XCircle, Clock, Trash2, Square } from "lucide-react";
import { NavBar } from "@/components/NavBar";
import {
  cancelExportJob,
  deleteExportJob,
  downloadExportJob,
  fetchExportJobStatus,
  listExportJobs,
  resumeNativeExportJob,
  type ExportJobStatusRow,
} from "@/lib/native-export-client";
import {
  deleteRenderAgentJob,
  downloadRenderAgentJob,
  fetchRenderAgentJobStatus,
  listRenderAgentJobs,
  probeRenderAgent,
  RENDER_AGENT_BASE,
  resumeRenderAgentJob,
} from "@/lib/render-agent-client";
import { getStoredSession } from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin";

export const Route = createFileRoute("/_authenticated/export")({
  validateSearch: (
    s: Record<string, unknown>,
  ): { jobId?: string; runner?: "agent" | "server" } => ({
    jobId: typeof s.jobId === "string" ? s.jobId : undefined,
    runner: s.runner === "agent" || s.runner === "server" ? s.runner : undefined,
  }),
  head: () => ({ meta: [{ title: "Export — Explainer Studio" }] }),
  component: ExportPage,
});

function statusIcon(status: ExportJobStatusRow["status"]) {
  if (status === "done") return <CheckCircle2 size={16} className="text-emerald-600" />;
  if (status === "error") return <XCircle size={16} className="text-destructive" />;
  if (status === "cancelled") return <Square size={16} className="text-muted-foreground" />;
  if (status === "running" || status === "queued") {
    return <Loader2 size={16} className="animate-spin text-primary" />;
  }
  return <Clock size={16} className="text-muted-foreground" />;
}

function ExportPage() {
  const { jobId: focusJobId, runner: focusRunner } = Route.useSearch();
  const [jobs, setJobs] = useState<ExportJobStatusRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const session = getStoredSession();
  const isAdmin =
    session?.user.isAdmin === true || isAdminEmail(session?.user.email);

  const refresh = useCallback(async () => {
    try {
      const agentUp = await probeRenderAgent();
      setAgentOnline(agentUp);

      const serverList = await listExportJobs({ allUsers: isAdmin });
      const serverJobs = serverList.map((j) => ({
        ...j,
        runner: j.runner ?? ("server" as const),
      }));

      let agentJobs: ExportJobStatusRow[] = [];
      if (agentUp) {
        try {
          agentJobs = await listRenderAgentJobs();
        } catch {
          agentJobs = [];
        }
      }

      if (
        focusJobId &&
        focusRunner === "agent" &&
        !agentJobs.some((j) => j.jobId === focusJobId)
      ) {
        try {
          const one = await fetchRenderAgentJobStatus(focusJobId);
          agentJobs = [one, ...agentJobs];
        } catch {
          /* keep */
        }
      }

      if (
        focusJobId &&
        focusRunner !== "agent" &&
        !serverJobs.some((j) => j.jobId === focusJobId)
      ) {
        try {
          const one = await fetchExportJobStatus(focusJobId);
          serverJobs.unshift({ ...one, runner: "server" });
        } catch {
          /* keep */
        }
      }

      const merged = [...agentJobs, ...serverJobs].sort(
        (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
      );
      setJobs(merged);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [focusJobId, focusRunner, isAdmin]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [refresh]);

  async function onDownload(job: ExportJobStatusRow) {
    setDownloadingId(job.jobId);
    try {
      if (job.runner === "agent") {
        await downloadRenderAgentJob(job.jobId, job.filename || "export.mp4");
      } else {
        await downloadExportJob(job.jobId, job.filename || "export.mp4");
      }
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloadingId(null);
    }
  }

  async function onDelete(job: ExportJobStatusRow) {
    if (
      !confirm(
        `Delete “${job.filename || "export"}”? This removes the file and cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingId(job.jobId);
    try {
      if (job.runner === "agent") {
        await deleteRenderAgentJob(job.jobId);
      } else {
        await deleteExportJob(job.jobId);
      }
      setJobs((prev) => prev.filter((j) => j.jobId !== job.jobId));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  async function onResume(job: ExportJobStatusRow) {
    setResumingId(job.jobId);
    try {
      if (job.runner === "agent") {
        await resumeRenderAgentJob(job.jobId);
      } else {
        await resumeNativeExportJob(job.jobId);
      }
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setResumingId(null);
    }
  }

  async function onStop(job: ExportJobStatusRow) {
    if (job.runner === "agent") {
      alert(
        "Stop from the Explainer Render Agent window for local jobs (server stop is not wired yet).",
      );
      return;
    }
    if (!confirm(`Stop export “${job.filename || "export"}”?`)) return;
    setStoppingId(job.jobId);
    try {
      await cancelExportJob(job.jobId);
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Stop failed");
    } finally {
      setStoppingId(null);
    }
  }

  const active = jobs.filter((j) => j.status === "queued" || j.status === "running");

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Film size={22} className="text-primary" />
            Export
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose <span className="text-foreground/90">Studio Mac</span> (encode on this host) or{" "}
            <span className="text-foreground/90">This Mac · Render Agent</span> (encode on the Mac
            where the agent app is open). Only the last 10 server exports are kept.
            Failed Studio Mac jobs can Resume — they reuse cached video and baked
            recording frames instead of starting over.
            {isAdmin ? " Admin view: server exports from all users are listed below." : ""}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Render Agent:{" "}
            {agentOnline === null
              ? "checking…"
              : agentOnline
                ? "online on this Mac"
                : "offline — open the agent (port 3850 stable, or 3851 isolated)"}
          </p>
        </div>

        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {active.length > 1 && (
          <p className="mb-4 text-xs text-muted-foreground">
            {active.length} exports running at once — heavy on CPU. Prefer one HD at a time if
            your Mac gets hot.
          </p>
        )}

        {jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center">
            <p className="text-sm text-muted-foreground">No export jobs yet.</p>
            <Link
              to="/compose"
              search={{}}
              className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Go to Compose
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {jobs.map((job) => {
              const focused = focusJobId === job.jobId;
              const pct = Math.round((job.progress ?? 0) * 100);
              return (
                <li
                  key={`${job.runner ?? "server"}-${job.jobId}`}
                  className={`rounded-lg border bg-card p-4 ${
                    focused ? "ring-2 ring-primary/40" : ""
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">{statusIcon(job.status)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium">{job.filename}</p>
                        {job.userEmail && (
                          <span className="truncate text-[11px] text-muted-foreground">
                            {job.userEmail}
                          </span>
                        )}
                        <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                          {job.runner === "agent" ? "this Mac" : "server"}
                        </span>
                        {job.quality && (
                          <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                            {job.quality === "hd" ? "1080p" : "720p"}
                          </span>
                        )}
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {job.status}
                        </span>
                      </div>
                      {(job.status === "running" || job.status === "queued") && (
                        <div className="mt-2">
                          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                            <span className="truncate pr-2">{job.stage || "working…"}</span>
                            <span className="tabular-nums">{pct}%</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full bg-primary transition-[width]"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {job.status === "error" && (
                        <p className="mt-2 text-sm text-destructive">{job.error ?? "Failed"}</p>
                      )}
                      {job.status === "cancelled" && (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {job.error ?? "Stopped by user"}
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {(job.status === "running" || job.status === "queued") &&
                          job.runner !== "agent" && (
                            <button
                              type="button"
                              disabled={stoppingId === job.jobId}
                              onClick={() => void onStop(job)}
                              className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/5 disabled:opacity-60"
                            >
                              {stoppingId === job.jobId ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Square size={14} />
                              )}
                              Stop export
                            </button>
                          )}
                        {job.status === "done" && (
                          <button
                            type="button"
                            disabled={downloadingId === job.jobId || deletingId === job.jobId}
                            onClick={() => void onDownload(job)}
                            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
                          >
                            {downloadingId === job.jobId ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Download size={14} />
                            )}
                            Download MP4
                          </button>
                        )}
                        {(job.status === "done" ||
                          job.status === "error" ||
                          job.status === "cancelled") && (
                          <button
                            type="button"
                            disabled={deletingId === job.jobId || downloadingId === job.jobId}
                            onClick={() => void onDelete(job)}
                            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/5 disabled:opacity-60"
                          >
                            {deletingId === job.jobId ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                            Delete
                          </button>
                        )}

                        {(job.status === "error" || job.status === "cancelled") && (
                            <button
                              type="button"
                              disabled={resumingId === job.jobId || deletingId === job.jobId || downloadingId === job.jobId}
                              onClick={() => void onResume(job)}
                              className="inline-flex items-center gap-2 rounded-md border border-primary/40 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-60"
                            >
                              {resumingId === job.jobId ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Clock size={14} />
                              )}
                              Resume
                            </button>
                          )}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
