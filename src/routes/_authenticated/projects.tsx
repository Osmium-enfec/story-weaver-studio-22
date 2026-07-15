import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listProjects } from "@/lib/projects.functions";
import { NavBar } from "@/components/NavBar";
import { Loader2, Plus, Play } from "lucide-react";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({
    meta: [{ title: "My Projects — Explainer Studio" }],
  }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const list = useServerFn(listProjects);
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => list(),
  });

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">My Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              All projects are saved on this Mac in <code className="text-xs">.data/</code>.
            </p>
          </div>
          <Link
            to="/compose"
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
              to="/compose"
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Plus size={14} /> Create your first project
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((p) => (
              <div key={p.id} className="rounded-lg border bg-card overflow-hidden">
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
                    Updated {new Date(p.updated_at).toLocaleDateString()} ·{" "}
                    {typeof p.scene_count === "number" ? `${p.scene_count} scenes · ` : ""}
                    {p.audio_mode === "upload" ? "Uploaded audio" : "TTS"}
                  </div>
                  <div className="mt-4">
                    <button
                      onClick={() => router.navigate({ to: "/compose", search: { project: p.id } })}
                      className="w-full inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90"
                    >
                      <Play size={14} /> Open
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
