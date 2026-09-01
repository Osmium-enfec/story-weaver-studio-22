import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiListCourses, apiSaveCourse } from "@/lib/courses-api";
import { apiListProjects } from "@/lib/projects-api";
import { NavBar } from "@/components/NavBar";
import { BookOpen, ChevronLeft, ChevronRight, Loader2, Play, Plus } from "lucide-react";
import { getStoredSession } from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin";

const PAGE_SIZE = 6;

export const Route = createFileRoute("/_authenticated/courses")({
  head: () => ({
    meta: [{ title: "My Courses — Div Studio" }],
  }),
  component: CoursesPage,
});

function pageSlice<T>(items: T[], page: number): T[] {
  const start = (page - 1) * PAGE_SIZE;
  return items.slice(start, start + PAGE_SIZE);
}

function totalPages(count: number): number {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

function PaginationBar({
  page,
  total,
  onPageChange,
  label,
}: {
  page: number;
  total: number;
  onPageChange: (p: number) => void;
  label: string;
}) {
  if (total <= 1) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-xs text-muted-foreground">
        {label} · page {page} of {total}
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

function CoursesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const session = getStoredSession();
  const isAdmin =
    session?.user.isAdmin === true || isAdminEmail(session?.user.email);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [coursesPage, setCoursesPage] = useState(1);
  const [episodesPage, setEpisodesPage] = useState(1);

  const { data: courses, isLoading: coursesLoading } = useQuery({
    queryKey: ["courses"],
    queryFn: () => apiListCourses(),
  });

  const { data: orphanEpisodes, isLoading: orphansLoading } = useQuery({
    queryKey: ["projects", "unassigned"],
    queryFn: async () => {
      const rows = await apiListProjects({ courseId: null });
      return Array.isArray(rows) ? rows : [];
    },
    enabled: isAdmin,
  });

  const coursesTotalPages = totalPages(courses?.length ?? 0);
  const episodesTotalPages = totalPages(orphanEpisodes?.length ?? 0);

  const pagedCourses = useMemo(() => {
    if (!courses) return [];
    const page = Math.min(coursesPage, coursesTotalPages);
    return pageSlice(courses, page);
  }, [courses, coursesPage, coursesTotalPages]);

  const pagedEpisodes = useMemo(() => {
    if (!orphanEpisodes) return [];
    const page = Math.min(episodesPage, episodesTotalPages);
    return pageSlice(orphanEpisodes, page);
  }, [orphanEpisodes, episodesPage, episodesTotalPages]);

  const createCourse = useMutation({
    mutationFn: async (title: string) => apiSaveCourse({ title }),
    onSuccess: async (res) => {
      setNewTitle("");
      await qc.invalidateQueries({ queryKey: ["courses"] });
      await router.navigate({ to: "/course/$id", params: { id: res.id } });
    },
  });

  async function handleCreateCourse() {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      await createCourse.mutateAsync(title);
    } finally {
      setCreating(false);
    }
  }

  const isLoading = coursesLoading || (isAdmin && orphansLoading);
  const safeCoursesPage = Math.min(coursesPage, coursesTotalPages);
  const safeEpisodesPage = Math.min(episodesPage, episodesTotalPages);

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">My Courses</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {isAdmin
                ? "Courses contain episodes. Create a course, then add episodes inside it."
                : "Open a course to create episodes. Only admins can create new courses."}
            </p>
          </div>
          {isAdmin ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreateCourse();
                }}
                placeholder="New course name"
                className="h-9 w-52 rounded-md border bg-background px-3 text-sm"
              />
              <button
                type="button"
                disabled={creating || !newTitle.trim()}
                onClick={() => void handleCreateCourse()}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                New course
              </button>
            </div>
          ) : null}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <section className="mb-10">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Courses
              </h2>
              {!courses || courses.length === 0 ? (
                <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
                  {isAdmin
                    ? "No courses yet. Create one above."
                    : "No courses assigned yet. Ask an admin to create a course and share it with you."}
                </div>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {pagedCourses.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          router.navigate({ to: "/course/$id", params: { id: c.id } })
                        }
                        className="rounded-lg border bg-card overflow-hidden text-left hover:border-primary/40"
                      >
                        <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
                          {c.thumbnail_url ? (
                            <img
                              src={c.thumbnail_url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <BookOpen size={32} className="text-muted-foreground" />
                          )}
                        </div>
                        <div className="p-4">
                          <div className="truncate font-medium">{c.title}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {c.episode_count} episode{c.episode_count === 1 ? "" : "s"} · Updated{" "}
                            {new Date(c.updated_at).toLocaleDateString()}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                  <PaginationBar
                    page={safeCoursesPage}
                    total={coursesTotalPages}
                    onPageChange={setCoursesPage}
                    label={`${courses.length} course${courses.length === 1 ? "" : "s"}`}
                  />
                </>
              )}
            </section>

            {isAdmin ? (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Episodes not in a course
              </h2>
              {!orphanEpisodes || orphanEpisodes.length === 0 ? (
                <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
                  No unassigned episodes.
                </div>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {pagedEpisodes.map((p) => (
                      <div key={p.id} className="rounded-lg border bg-card overflow-hidden">
                        <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
                          {p.thumbnail_url ? (
                            <img
                              src={p.thumbnail_url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <Play size={32} className="text-muted-foreground" />
                          )}
                        </div>
                        <div className="p-4">
                          <div className="truncate font-medium">{p.title}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Updated {new Date(p.updated_at).toLocaleDateString()} ·{" "}
                            {typeof p.part_count === "number"
                              ? `${p.part_count} part${p.part_count === 1 ? "" : "s"}`
                              : `${p.scene_count} scenes`}
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              router.navigate({
                                to: "/episode/$id",
                                params: { id: p.id },
                              })
                            }
                            className="mt-4 w-full inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90"
                          >
                            <Play size={14} /> Open episode
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <PaginationBar
                    page={safeEpisodesPage}
                    total={episodesTotalPages}
                    onPageChange={setEpisodesPage}
                    label={`${orphanEpisodes.length} episode${orphanEpisodes.length === 1 ? "" : "s"}`}
                  />
                </>
              )}
              <div className="mt-4">
                <Link
                  to="/compose"
                  search={{}}
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <Plus size={14} /> New episode in Compose
                </Link>
              </div>
            </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
