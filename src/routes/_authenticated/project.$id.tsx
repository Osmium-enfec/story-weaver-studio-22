import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getProject } from "@/lib/projects.functions";
import { VideoPlayer, type Scene } from "@/components/VideoPlayer";
import { NavBar } from "@/components/NavBar";
import { Loader2, ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/project/$id")({
  head: () => ({ meta: [{ title: "Project — Explainer Studio" }] }),
  component: ProjectDetail,
});

function ProjectDetail() {
  const { id } = Route.useParams();
  const get = useServerFn(getProject);
  const { data, isLoading, error } = useQuery({
    queryKey: ["project", id],
    queryFn: () => get({ data: { id } }),
  });

  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      <div className="mx-auto max-w-4xl px-6 py-8">
        <Link to="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft size={14} /> Back to projects
        </Link>
        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="animate-spin" /></div>
        ) : error ? (
          <div className="text-destructive">{(error as Error).message}</div>
        ) : data ? (
          <>
            <h1 className="text-2xl font-bold mb-1">{data.title}</h1>
            <div className="text-xs text-muted-foreground mb-6">
              Saved {new Date(data.updated_at).toLocaleString()}
            </div>
            <VideoPlayer scenes={data.scenes as Scene[]} />
          </>
        ) : null}
      </div>
    </div>
  );
}
