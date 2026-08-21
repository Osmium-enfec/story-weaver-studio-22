import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiGetCourse } from "@/lib/courses-api";
import {
  apiGetProject,
  apiListProjects,
  apiSaveProject,
  type ProjectListItem,
} from "@/lib/projects-api";
import { NavBar } from "@/components/NavBar";
import { WorkingOnLabel } from "@/components/AssignUserSelect";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Play,
  Plus,
  X,
} from "lucide-react";

const PAGE_SIZE = 9;

export const Route = createFileRoute("/_authenticated/course/$id")({
  head: () => ({
    meta: [{ title: "Course — Explainer Studio" }],
  }),
  component: CourseDetailPage,
});

function totalPages(count: number): number {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

function CourseDetailPage() {
  const { id } = Route.useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const [episodeTitle, setEpisodeTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const { data: course, isLoading: courseLoading, error: courseError } = useQuery({
    queryKey: ["course", id],
    queryFn: () => apiGetCourse(id),
  });

  const { data: episodes, isLoading: episodesLoading } = useQuery({
    queryKey: ["projects", "course", id],
    queryFn: () => apiListProjects({ courseId: id }),
  });

  const createEpisode = useMutation({
    mutationFn: async (title: string) =>
      apiSaveProject({
        title,
        audio_mode: "tts",
        scenes: [],
        parts: [],
        course_id: id,
      }),
    onSuccess: async (res) => {
      setEpisodeTitle("");
      await qc.invalidateQueries({ queryKey: ["projects", "course", id] });
      await qc.invalidateQueries({ queryKey: ["courses"] });
      await router.navigate({ to: "/episode/$id", params: { id: res.id } });
    },
  });

  async function handleCreateEpisode() {
    const title = episodeTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      await createEpisode.mutateAsync(title);
    } finally {
      setCreating(false);
    }
  }

  function startEdit(ep: ProjectListItem) {
    setEditingId(ep.id);
    setEditTitle(ep.title);
    setRenameError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditTitle("");
    setRenameError(null);
  }

  async function saveEpisodeTitle(epId: string) {
    const title = editTitle.trim();
    if (!title || renaming) return;
    setRenaming(true);
    setRenameError(null);
    try {
      const full = await apiGetProject(epId);
      await apiSaveProject({
        id: full.id,
        title,
        script: full.script ?? undefined,
        audio_mode: (full.audio_mode as "tts" | "upload") || "tts",
        scenes: full.scenes ?? [],
        parts: full.parts ?? [],
        thumbnail_url: full.thumbnail_url ?? undefined,
        course_id: full.course_id ?? id,
      });
      await qc.invalidateQueries({ queryKey: ["projects", "course", id] });
      await qc.invalidateQueries({ queryKey: ["project", epId] });
      await qc.invalidateQueries({ queryKey: ["courses"] });
      cancelEdit();
    } catch (e: unknown) {
      setRenameError(e instanceof Error ? e.message : "Could not rename episode");
    } finally {
      setRenaming(false);
    }
  }

  const isLoading = courseLoading || episodesLoading;

  const pages = totalPages(episodes?.length ?? 0);
  const safePage = Math.min(page, pages);
  const pagedEpisodes = useMemo(() => {
    if (!episodes) return [];
    const start = (safePage - 1) * PAGE_SIZE;
    return episodes.slice(start, start + PAGE_SIZE);
  }, [episodes, safePage]);

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Link
          to="/courses"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> My Courses
        </Link>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-muted-foreground" />
          </div>
        ) : courseError || !course ? (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            {courseError instanceof Error ? courseError.message : "Course not found."}
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold">{course.title}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Episodes in this course. Open an episode to see its parts.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={episodeTitle}
                  onChange={(e) => setEpisodeTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateEpisode();
                  }}
                  placeholder="New episode name"
                  className="h-9 w-52 rounded-md border bg-background px-3 text-sm"
                />
                <button
                  type="button"
                  disabled={creating || !episodeTitle.trim()}
                  onClick={() => void handleCreateEpisode()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {creating ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  New episode
                </button>
              </div>
            </div>

            {renameError && (
              <p className="mb-4 text-sm text-destructive">{renameError}</p>
            )}

            {!episodes || episodes.length === 0 ? (
              <div className="rounded-lg border bg-card p-12 text-center">
                <p className="text-muted-foreground">No episodes in this course yet.</p>
              </div>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {pagedEpisodes.map((ep) => (
                    <div key={ep.id} className="rounded-lg border bg-card overflow-hidden">
                      <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
                        {ep.thumbnail_url ? (
                          <img
                            src={ep.thumbnail_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <Play size={32} className="text-muted-foreground" />
                        )}
                      </div>
                      <div className="p-4">
                        {editingId === ep.id ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveEpisodeTitle(ep.id);
                                if (e.key === "Escape") cancelEdit();
                              }}
                              autoFocus
                              disabled={renaming}
                              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm font-medium"
                            />
                            <button
                              type="button"
                              disabled={renaming || !editTitle.trim()}
                              onClick={() => void saveEpisodeTitle(ep.id)}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
                              title="Save"
                            >
                              {renaming ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Check size={14} />
                              )}
                            </button>
                            <button
                              type="button"
                              disabled={renaming}
                              onClick={cancelEdit}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
                              title="Cancel"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-start gap-1.5">
                            <div className="min-w-0 flex-1 truncate font-medium">
                              {ep.title}
                            </div>
                            <button
                              type="button"
                              onClick={() => startEdit(ep)}
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                              title="Rename episode"
                            >
                              <Pencil size={14} />
                            </button>
                          </div>
                        )}
                        <div className="mt-1 text-xs text-muted-foreground">
                          Updated {new Date(ep.updated_at).toLocaleDateString()} ·{" "}
                          {typeof ep.part_count === "number"
                            ? `${ep.part_count} part${ep.part_count === 1 ? "" : "s"}`
                            : `${ep.scene_count} scenes`}
                        </div>
                        <WorkingOnLabel partEmails={ep.part_assignee_emails} />
                        <button
                          type="button"
                          onClick={() =>
                            router.navigate({
                              to: "/episode/$id",
                              params: { id: ep.id },
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
                {pages > 1 && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <p className="text-xs text-muted-foreground">
                      {episodes.length} episode{episodes.length === 1 ? "" : "s"} · page{" "}
                      {safePage} of {pages}
                    </p>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={safePage <= 1}
                        onClick={() => setPage(safePage - 1)}
                        className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-40"
                      >
                        <ChevronLeft size={14} /> Prev
                      </button>
                      <button
                        type="button"
                        disabled={safePage >= pages}
                        onClick={() => setPage(safePage + 1)}
                        className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-40"
                      >
                        Next <ChevronRight size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
