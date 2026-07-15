import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listProjects, deleteProject } from "@/lib/projects.functions";
import { NavBar } from "@/components/NavBar";
import { Loader2, Plus, Trash2, Play } from "lucide-react";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({
    meta: [{ title: "My Project — Explainer Studio" }],
  }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const list = useServerFn(listProjects);
  const del = useServerFn(deleteProject);
  const router = useRouter();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["projects"],
    queryFn: () => list(),
  });

  async function handleDelete(id: string) {
    if (!confirm("Delete this project?")) return;
    await del({ data: { id } });
    refetch();
  }

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">My Project</h1>
          <Link
            to="/compose"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus size={14} /> Compose scene
          </Link>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="animate-spin text-muted-foreground" /></div>
        ) : !data || data.length === 0 ? (
          <div className="rounded-lg border bg-card p-12 text-center">
            <p className="text-muted-foreground">No saved project yet.</p>
            <Link
              to="/compose"
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Plus size={14} /> Create your first project
            </Link>
          </div>
        ) : (
          <div className="mx-auto max-w-md">
            {(() => {
              const p = data[0];
              return (
                <div className="rounded-lg border bg-card overflow-hidden">
                  <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
                    {p.thumbnail_url ? (
                      <img src={p.thumbnail_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <Play size={32} className="text-muted-foreground" />
                    )}
                  </div>
                  <div className="p-4">
                    <div className="font-medium truncate">{p.title}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Created {new Date(p.created_at ?? p.updated_at).toLocaleDateString()} ·{" "}
                      {typeof p.scene_count === "number" ? `${p.scene_count} scenes · ` : ""}
                      {p.audio_mode === "upload" ? "Uploaded audio" : "TTS"}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Only your most recent project is kept to save storage.
                    </p>
                    <div className="mt-4 flex gap-2">
                      <button
                        onClick={() => router.navigate({ to: "/compose", search: { project: p.id } })}
                        className="flex-1 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90"
                      >
                        <Play size={14} /> Open
                      </button>
                      <button
                        onClick={() => handleDelete(p.id)}
                        className="rounded-md border px-3 py-2 text-sm hover:bg-destructive/10 hover:text-destructive"
                        title="Delete project"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
