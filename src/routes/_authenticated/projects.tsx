import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listProjects, deleteProject } from "@/lib/projects.functions";
import { NavBar } from "@/components/NavBar";
import { Loader2, Plus, Trash2, Play } from "lucide-react";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({
    meta: [{ title: "My Projects — Explainer Studio" }],
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
          <h1 className="text-2xl font-bold">My Projects</h1>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus size={14} /> New project
          </Link>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="animate-spin text-muted-foreground" /></div>
        ) : !data || data.length === 0 ? (
          <div className="rounded-lg border bg-card p-12 text-center">
            <p className="text-muted-foreground">No saved projects yet.</p>
            <Link
              to="/"
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Plus size={14} /> Create your first project
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((p: any) => (
              <div key={p.id} className="rounded-lg border bg-card overflow-hidden group">
                <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
                  {p.thumbnail_url ? (
                    <img src={p.thumbnail_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Play size={32} className="text-muted-foreground" />
                  )}
                </div>
                <div className="p-3">
                  <div className="font-medium truncate">{p.title}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {new Date(p.updated_at).toLocaleDateString()} · {p.audio_mode === "upload" ? "Uploaded audio" : "TTS"}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => router.navigate({ to: "/project/$id", params: { id: p.id } })}
                      className="flex-1 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-xs text-primary-foreground hover:opacity-90"
                    >
                      <Play size={12} /> Open
                    </button>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="rounded-md border px-2 py-1.5 text-xs hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
