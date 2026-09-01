import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  apiAssignPart,
  apiDeletePart,
  apiGetProject,
  apiSaveProject,
} from "@/lib/projects-api";
import { createClientId } from "@/lib/client-id";
import { getStoredSession } from "@/lib/auth-client";
import {
  defaultPartTitle,
  getProjectParts,
  partThumb,
  type ProjectPart,
} from "@/lib/project-parts";
import { NavBar } from "@/components/NavBar";
import { AssignUserSelect, WorkingOnLabel } from "@/components/AssignUserSelect";
import {
  ArrowLeft,
  Check,
  Film,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/episode/$id")({
  head: () => ({
    meta: [{ title: "Episode — Explainer Studio" }],
  }),
  component: EpisodeDetailPage,
});

function EpisodeDetailPage() {
  const { id } = Route.useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const [partTitle, setPartTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingPartId, setEditingPartId] = useState<string | null>(null);
  const [editPartTitle, setEditPartTitle] = useState("");
  const [renamingPart, setRenamingPart] = useState(false);
  const [editingEpisode, setEditingEpisode] = useState(false);
  const [editEpisodeTitle, setEditEpisodeTitle] = useState("");
  const [renamingEpisode, setRenamingEpisode] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deletingPartId, setDeletingPartId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["project", id],
    queryFn: async () => {
      const timeoutMs = 25_000;
      return Promise.race([
        apiGetProject(id),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "This episode is taking too long to load. Open it from Compose instead.",
                ),
              ),
            timeoutMs,
          ),
        ),
      ]);
    },
    retry: 1,
    staleTime: 10_000,
  });

  const session = getStoredSession();
  const isAdmin = session?.user.isAdmin ?? false;
  const myUserId = session?.user.id ?? null;
  const myEmail = session?.user.email?.trim().toLowerCase() ?? null;
  const parts = getProjectParts(data).filter((part) => {
    if (isAdmin) return true;
    if (myUserId && part.assignedUserId === myUserId) return true;
    if (myEmail && part.assignedUserEmail?.trim().toLowerCase() === myEmail) return true;
    return false;
  });
  const backToCourse = data?.course_id;

  const createPart = useMutation({
    mutationFn: async (title: string) => {
      if (!data) throw new Error("Episode not loaded.");
      const now = new Date().toISOString();
      const existing = getProjectParts(data);
      const newPart: ProjectPart = {
        id: createClientId(),
        title,
        scenes: [],
        masterAudioUrl: "",
        durationMs: 0,
        ...(isAdmin
          ? {}
          : {
              assignedUserId: myUserId ?? null,
              assignedUserEmail: session?.user.email ?? null,
            }),
        created_at: now,
        updated_at: now,
      };
      await apiSaveProject({
        id: data.id,
        title: data.title,
        script: data.script ?? undefined,
        audio_mode: data.audio_mode as "tts" | "upload",
        scenes: data.scenes ?? [],
        parts: [...existing, newPart],
        thumbnail_url: data.thumbnail_url ?? undefined,
        course_id: data.course_id ?? undefined,
      });
      return newPart;
    },
    onSuccess: async () => {
      setPartTitle("");
      setCreateError(null);
      await qc.invalidateQueries({ queryKey: ["project", id] });
      if (backToCourse) {
        await qc.invalidateQueries({ queryKey: ["projects", "course", backToCourse] });
      }
    },
  });

  async function handleCreatePart() {
    if (!data || creating) return;
    const title = partTitle.trim() || defaultPartTitle(parts);
    setCreating(true);
    setCreateError(null);
    try {
      await createPart.mutateAsync(title);
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Could not create part");
    } finally {
      setCreating(false);
    }
  }

  async function saveEpisodeTitle() {
    if (!data || renamingEpisode) return;
    const title = editEpisodeTitle.trim();
    if (!title) return;
    setRenamingEpisode(true);
    setRenameError(null);
    try {
      await apiSaveProject({
        id: data.id,
        title,
        script: data.script ?? undefined,
        audio_mode: data.audio_mode as "tts" | "upload",
        scenes: data.scenes ?? [],
        parts: getProjectParts(data),
        thumbnail_url: data.thumbnail_url ?? undefined,
        course_id: data.course_id ?? undefined,
      });
      await qc.invalidateQueries({ queryKey: ["project", id] });
      if (backToCourse) {
        await qc.invalidateQueries({ queryKey: ["projects", "course", backToCourse] });
      }
      await qc.invalidateQueries({ queryKey: ["courses"] });
      setEditingEpisode(false);
    } catch (e: unknown) {
      setRenameError(e instanceof Error ? e.message : "Could not rename episode");
    } finally {
      setRenamingEpisode(false);
    }
  }

  async function savePartTitle(partId: string) {
    if (!data || renamingPart) return;
    const title = editPartTitle.trim();
    if (!title) return;
    setRenamingPart(true);
    setRenameError(null);
    try {
      const now = new Date().toISOString();
      const nextParts = getProjectParts(data).map((p) =>
        p.id === partId ? { ...p, title, updated_at: now } : p,
      );
      await apiSaveProject({
        id: data.id,
        title: data.title,
        script: data.script ?? undefined,
        audio_mode: data.audio_mode as "tts" | "upload",
        scenes: data.scenes ?? [],
        parts: nextParts,
        thumbnail_url: data.thumbnail_url ?? undefined,
        course_id: data.course_id ?? undefined,
      });
      await qc.invalidateQueries({ queryKey: ["project", id] });
      if (backToCourse) {
        await qc.invalidateQueries({ queryKey: ["projects", "course", backToCourse] });
      }
      setEditingPartId(null);
      setEditPartTitle("");
    } catch (e: unknown) {
      setRenameError(e instanceof Error ? e.message : "Could not rename part");
    } finally {
      setRenamingPart(false);
    }
  }

  async function handleDeletePart(part: ProjectPart) {
    if (deletingPartId) return;
    if (
      !confirm(
        `Delete part \u201C${part.title}\u201D? This permanently removes its ${part.scenes.length} scene(s) from this episode.`,
      )
    ) {
      return;
    }
    setDeletingPartId(part.id);
    setRenameError(null);
    try {
      await apiDeletePart(id, part.id);
      await qc.invalidateQueries({ queryKey: ["project", id] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
      if (backToCourse) {
        await qc.invalidateQueries({ queryKey: ["projects", "course", backToCourse] });
      }
    } catch (e: unknown) {
      setRenameError(e instanceof Error ? e.message : "Could not delete part");
    } finally {
      setDeletingPartId(null);
    }
  }

  function openPart(partId: string) {
    void router.navigate({
      to: "/compose",
      search: { project: id, part: partId },
    });
  }

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto max-w-5xl px-6 py-10">
        {backToCourse ? (
          <Link
            to="/course/$id"
            params={{ id: backToCourse }}
            className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={14} /> Back to course
          </Link>
        ) : (
          <Link
            to="/courses"
            className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={14} /> My Courses
          </Link>
        )}

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-muted-foreground" />
          </div>
        ) : error || !data ? (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Episode not found."}
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Episode
                </p>
                {editingEpisode ? (
                  <div className="mt-1 flex max-w-xl items-center gap-1.5">
                    <input
                      type="text"
                      value={editEpisodeTitle}
                      onChange={(e) => setEditEpisodeTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveEpisodeTitle();
                        if (e.key === "Escape") setEditingEpisode(false);
                      }}
                      autoFocus
                      disabled={renamingEpisode}
                      className="h-10 min-w-0 flex-1 rounded-md border bg-background px-3 text-xl font-bold"
                    />
                    <button
                      type="button"
                      disabled={renamingEpisode || !editEpisodeTitle.trim()}
                      onClick={() => void saveEpisodeTitle()}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
                      title="Save"
                    >
                      {renamingEpisode ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Check size={16} />
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={renamingEpisode}
                      onClick={() => setEditingEpisode(false)}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
                      title="Cancel"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <h1 className="text-2xl font-bold">{data.title}</h1>
                    <button
                      type="button"
                      onClick={() => {
                        setEditEpisodeTitle(data.title);
                        setEditingEpisode(true);
                        setRenameError(null);
                      }}
                      className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="Rename episode"
                    >
                      <Pencil size={16} />
                    </button>
                  </div>
                )}
                <p className="mt-1 text-sm text-muted-foreground">
                  Create parts here, then open a part to edit in Compose.
                </p>
                <WorkingOnLabel
                  partEmails={parts
                    .map((p) => p.assignedUserEmail?.trim())
                    .filter((e): e is string => !!e)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={partTitle}
                  onChange={(e) => setPartTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreatePart();
                  }}
                  placeholder={defaultPartTitle(parts)}
                  className="h-9 w-52 rounded-md border bg-background px-3 text-sm"
                />
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => void handleCreatePart()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {creating ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  Create part
                </button>
              </div>
            </div>

            {(createError || renameError) && (
              <p className="mb-4 text-sm text-destructive">
                {createError || renameError}
              </p>
            )}

            {parts.length === 0 ? (
              <div className="rounded-lg border bg-card p-12 text-center">
                <p className="text-muted-foreground">
                  No parts yet. Create a part above, then open it to compose scenes.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {parts.map((part) => (
                  <div key={part.id} className="rounded-lg border bg-card overflow-hidden">
                    <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
                      {partThumb(part) ? (
                        <img
                          src={partThumb(part)!}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Film size={32} className="text-muted-foreground" />
                      )}
                    </div>
                    <div className="p-4">
                      {editingPartId === part.id ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={editPartTitle}
                            onChange={(e) => setEditPartTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void savePartTitle(part.id);
                              if (e.key === "Escape") {
                                setEditingPartId(null);
                                setEditPartTitle("");
                              }
                            }}
                            autoFocus
                            disabled={renamingPart}
                            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm font-medium"
                          />
                          <button
                            type="button"
                            disabled={renamingPart || !editPartTitle.trim()}
                            onClick={() => void savePartTitle(part.id)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
                            title="Save"
                          >
                            {renamingPart ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Check size={14} />
                            )}
                          </button>
                          <button
                            type="button"
                            disabled={renamingPart}
                            onClick={() => {
                              setEditingPartId(null);
                              setEditPartTitle("");
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
                            title="Cancel"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-start gap-1.5">
                          <div className="min-w-0 flex-1 truncate font-medium">
                            {part.title}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingPartId(part.id);
                              setEditPartTitle(part.title);
                              setRenameError(null);
                            }}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                            title="Rename part"
                          >
                            <Pencil size={14} />
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              disabled={deletingPartId === part.id}
                              onClick={() => void handleDeletePart(part)}
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                              title="Delete part"
                            >
                              {deletingPartId === part.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Trash2 size={14} />
                              )}
                            </button>
                          )}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {part.scenes.length} scene{part.scenes.length === 1 ? "" : "s"}
                        {!part.scenes.length ? " · draft" : ""}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Working:{" "}
                        <span className="text-foreground/80">
                          {part.assignedUserEmail?.trim() || "Unassigned"}
                        </span>
                      </p>
                      <AssignUserSelect
                        valueUserId={part.assignedUserId}
                        valueEmail={part.assignedUserEmail}
                        label="Assign part"
                        onAssign={async (userId) => {
                          await apiAssignPart(id, part.id, userId);
                          await qc.invalidateQueries({ queryKey: ["project", id] });
                          if (backToCourse) {
                            await qc.invalidateQueries({
                              queryKey: ["projects", "course", backToCourse],
                            });
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => openPart(part.id)}
                        className="mt-4 w-full inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90"
                      >
                        <Play size={14} /> Open part
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
