import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Shield,
  Users,
  BookOpen,
  Film,
  Loader2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  UserRound,
  Trash2,
  Clapperboard,
} from "lucide-react";
import { NavBar } from "@/components/NavBar";
import { getStoredSession } from "@/lib/auth-client";
import {
  apiAdminDeleteUser,
  apiAdminOverview,
  type AdminOverview,
} from "@/lib/admin-api";
import {
  apiDeleteBundle,
  apiListBundles,
  type RenderBundleItem,
} from "@/lib/render-bundles-api";

import { AssignmentSheet } from "@/components/admin/AssignmentSheet";
import { isAdminEmail } from "@/lib/admin";

const PAGE_SIZE = 8;

export const Route = createFileRoute("/_authenticated/admin")({
  ssr: false,
  beforeLoad: () => {
    const session = getStoredSession();
    if (!session?.user) throw redirect({ to: "/auth" });
    const email = session.user.email?.toLowerCase() ?? "";
    const isAdmin =
      (session.user as { isAdmin?: boolean }).isAdmin === true ||
      isAdminEmail(email);
    if (!isAdmin) throw redirect({ to: "/compose", search: {} });
  },
  head: () => ({ meta: [{ title: "Admin — Explainer Studio" }] }),
  component: AdminPage,
});

function fmtWhen(isoOrMs: string | number) {
  const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function totalPages(count: number): number {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

function PaginationBar({
  page,
  total,
  count,
  label,
  onPageChange,
}: {
  page: number;
  total: number;
  count: number;
  label: string;
  onPageChange: (p: number) => void;
}) {
  if (count <= PAGE_SIZE) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-xs text-muted-foreground">
        {count} {label} · page {page} of {total}
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-40"
        >
          <ChevronLeft size={14} /> Prev
        </button>
        <button
          type="button"
          disabled={page >= total}
          onClick={() => onPageChange(page + 1)}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-40"
        >
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

function AdminPage() {
  const session = getStoredSession();
  const selfId = session?.user.id ?? null;
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<
    "users" | "courses" | "assignment" | "assignments" | "bundles"
  >("users");
  const [usersPage, setUsersPage] = useState(1);
  const [coursesPage, setCoursesPage] = useState(1);
  const [assignmentsPage, setAssignmentsPage] = useState(1);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [bundles, setBundles] = useState<RenderBundleItem[] | null>(null);
  const [bundlesError, setBundlesError] = useState<string | null>(null);


  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setError(null);
      const overview = await apiAdminOverview();
      setData(overview);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshBundles = useCallback(async () => {
    try {
      setBundlesError(null);
      const { bundles: rows } = await apiListBundles({ all: true });
      setBundles(rows);
    } catch (e: unknown) {
      setBundlesError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (tab !== "bundles") return;
    void refreshBundles();
    const t = setInterval(() => void refreshBundles(), 8000);
    return () => clearInterval(t);
  }, [tab, refreshBundles]);



  async function onDeleteUser(userId: string, email: string) {
    if (
      !confirm(
        `Delete account “${email}”?\n\nThis signs them out and removes the account. Their courses/episodes stay on this Mac. Assignments to them are cleared.`,
      )
    ) {
      return;
    }
    setDeletingUserId(userId);
    try {
      await apiAdminDeleteUser(userId);
      await refresh({ silent: true });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Could not delete user");
    } finally {
      setDeletingUserId(null);
    }
  }

  const usersPages = totalPages(data?.users.length ?? 0);
  const coursesPages = totalPages(data?.courses.length ?? 0);
  const assignmentsPages = totalPages(data?.assignments.length ?? 0);
  const safeUsersPage = Math.min(usersPage, usersPages);
  const safeCoursesPage = Math.min(coursesPage, coursesPages);
  const safeAssignmentsPage = Math.min(assignmentsPage, assignmentsPages);

  const pagedUsers = useMemo(() => {
    if (!data) return [];
    const start = (safeUsersPage - 1) * PAGE_SIZE;
    return data.users.slice(start, start + PAGE_SIZE);
  }, [data, safeUsersPage]);

  const pagedCourses = useMemo(() => {
    if (!data) return [];
    const start = (safeCoursesPage - 1) * PAGE_SIZE;
    return data.courses.slice(start, start + PAGE_SIZE);
  }, [data, safeCoursesPage]);

  const pagedAssignments = useMemo(() => {
    if (!data) return [];
    const start = (safeAssignmentsPage - 1) * PAGE_SIZE;
    return data.assignments.slice(start, start + PAGE_SIZE);
  }, [data, safeAssignmentsPage]);

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Shield size={22} className="text-primary" />
              Admin
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Users, courses, and exports on this Mac.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void refresh();
            }}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {loading && !data ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </p>
        ) : data ? (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
              <Stat label="Users" value={data.summary.userCount} icon={Users} />
              <Stat label="Courses" value={data.summary.courseCount} icon={BookOpen} />
              <Stat label="Episodes" value={data.summary.episodeCount} icon={BookOpen} />
              <Stat
                label="Assignments"
                value={data.summary.assignmentCount}
                icon={UserRound}
              />
              <Stat
                label="Saved scenes"
                value={data.summary.savedSceneCount ?? 0}
                icon={Clapperboard}
              />
              <Stat label="Export jobs" value={data.summary.exportJobCount} icon={Film} />
              <Stat label="Active exports" value={data.summary.activeExports} icon={Film} />
            </div>

            <div className="mb-4 flex flex-wrap gap-1 rounded-lg border p-1">
              {(
                [
                  ["users", "Users"],
                  ["courses", "Courses"],
                  ["assignment", "Assignment"],
                  ["assignments", "Assigned"],
                  ["bundles", "Ready for HD"],

                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`min-w-[5.5rem] flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    tab === id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "users" && (
              <>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Email</th>
                        <th className="px-3 py-2 font-medium">Role</th>
                        <th className="px-3 py-2 font-medium">Courses</th>
                        <th className="px-3 py-2 font-medium">Episodes</th>
                        <th className="px-3 py-2 font-medium">Assigned</th>
                        <th className="px-3 py-2 font-medium">Scenes</th>
                        <th className="px-3 py-2 font-medium">Sessions</th>
                        <th className="px-3 py-2 font-medium">Exporting</th>
                        <th className="px-3 py-2 font-medium">Joined</th>
                        <th className="px-3 py-2 font-medium"> </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedUsers.map((u) => (
                        <tr key={u.id} className="border-b last:border-0">
                          <td className="px-3 py-2 font-medium">{u.email}</td>
                          <td className="px-3 py-2">
                            {u.isAdmin ? (
                              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                                Admin
                              </span>
                            ) : (
                              <span className="text-muted-foreground">User</span>
                            )}
                          </td>
                          <td className="px-3 py-2 tabular-nums">{u.courseCount}</td>
                          <td className="px-3 py-2 tabular-nums">{u.episodeCount}</td>
                          <td className="px-3 py-2 tabular-nums">{u.assignmentCount}</td>
                          <td className="px-3 py-2 tabular-nums font-medium">
                            {u.savedSceneCount > 0 ? u.savedSceneCount : "—"}
                          </td>
                          <td className="px-3 py-2 tabular-nums">{u.activeSessions}</td>
                          <td className="px-3 py-2 tabular-nums">
                            {u.exportJobsRunning > 0 ? (
                              <span className="text-primary">{u.exportJobsRunning} running</span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {fmtWhen(u.created_at)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {!u.isAdmin && u.id !== selfId ? (
                              <button
                                type="button"
                                disabled={deletingUserId === u.id}
                                onClick={() => void onDeleteUser(u.id, u.email)}
                                className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/5 disabled:opacity-50"
                                title="Delete account"
                              >
                                {deletingUserId === u.id ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <Trash2 size={12} />
                                )}
                                Delete
                              </button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <PaginationBar
                  page={safeUsersPage}
                  total={usersPages}
                  count={data.users.length}
                  label="users"
                  onPageChange={setUsersPage}
                />
              </>
            )}

            {tab === "courses" && (
              <>
                <ul className="space-y-2">
                  {data.courses.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No courses yet.</p>
                  ) : (
                    pagedCourses.map((c) => (
                      <li
                        key={c.id}
                        className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm"
                      >
                        {c.thumbnail_url ? (
                          <img
                            src={c.thumbnail_url}
                            alt=""
                            className="h-12 w-16 rounded border object-cover"
                          />
                        ) : (
                          <div className="flex h-12 w-16 items-center justify-center rounded border bg-muted">
                            <BookOpen size={16} />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{c.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {c.userEmail} · {c.episode_count} episode
                            {c.episode_count === 1 ? "" : "s"} · {fmtWhen(c.updated_at)}
                          </p>
                        </div>
                        <Link
                          to="/course/$id"
                          params={{ id: c.id }}
                          className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                        >
                          Open
                        </Link>
                      </li>
                    ))
                  )}
                </ul>
                <PaginationBar
                  page={safeCoursesPage}
                  total={coursesPages}
                  count={data.courses.length}
                  label="courses"
                  onPageChange={setCoursesPage}
                />
              </>
            )}

            {tab === "assignment" && (
              <AssignmentSheet
                courses={data.courses.map((c) => ({
                  id: c.id,
                  title: c.title,
                  episode_count: c.episode_count,
                }))}
              />
            )}

            {tab === "assignments" && (
              <>
                <ul className="space-y-2">
                  {data.assignments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No episode or part assignments yet.
                    </p>
                  ) : (
                    pagedAssignments.map((a) => (
                      <li
                        key={`${a.kind}-${a.episodeId}-${a.partId ?? "ep"}`}
                        className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm"
                      >
                        <div className="flex h-10 w-10 items-center justify-center rounded border bg-muted">
                          <UserRound size={16} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">
                            {a.kind === "episode"
                              ? a.episodeTitle
                              : `${a.partTitle ?? "Part"} · ${a.episodeTitle}`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {a.kind === "episode" ? "Episode" : "Part"} →{" "}
                            <span className="text-foreground/80">{a.assignedUserEmail}</span>
                            {a.kind === "part" ? (
                              <>
                                {" · "}
                                <span className="font-medium text-foreground">
                                  {a.sceneCount ?? 0} scene
                                  {(a.sceneCount ?? 0) === 1 ? "" : "s"} saved
                                </span>
                              </>
                            ) : null}
                            {" · "}
                            {fmtWhen(a.updated_at)}
                          </p>
                        </div>
                        <Link
                          to="/episode/$id"
                          params={{ id: a.episodeId }}
                          className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                        >
                          Open episode
                        </Link>
                      </li>
                    ))
                  )}
                </ul>
                <PaginationBar
                  page={safeAssignmentsPage}
                  total={assignmentsPages}
                  count={data.assignments.length}
                  label="assignments"
                  onPageChange={setAssignmentsPage}
                />
              </>
            )}

            {tab === "bundles" && (
              <>
                {bundlesError && (
                  <p className="mb-2 text-sm text-destructive">{bundlesError}</p>
                )}
                <ul className="space-y-2">
                  {bundles == null ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                  ) : bundles.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No parts marked “Ready for HD” yet.
                    </p>
                  ) : (
                    bundles.map((b) => (
                      <li key={b.id} className="rounded-lg border bg-card p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="font-medium">
                              {b.episodeTitle} — {b.partTitle}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {b.ownerEmail} · {b.sceneCount} scenes ·{" "}
                              {Math.round(b.durationMs / 1000)}s · {b.status} ·{" "}
                              {new Date(b.readyAt).toLocaleString()}
                            </p>
                            {b.error && (
                              <p className="mt-1 text-xs text-destructive">{b.error}</p>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {b.outputUrl && (
                              <a
                                href={b.outputUrl}
                                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                              >
                                Download MP4
                              </a>
                            )}
                            <button
                              type="button"
                              className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/5"
                              onClick={() =>
                                void apiDeleteBundle(b.id)
                                  .then(() => refreshBundles())
                                  .catch((e) =>
                                    alert(e instanceof Error ? e.message : String(e)),
                                  )
                              }
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      </li>
                    ))
                  )}
                </ul>
              </>
            )}

          </>
        ) : null}
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Users;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon size={12} />
        {label}
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
