import { Loader2 } from "lucide-react";

interface ComposeCreateProjectCardProps {
  projectTitle: string;
  onProjectTitleChange: (v: string) => void;
  partTitle: string;
  onPartTitleChange: (v: string) => void;
  creating: boolean;
  onCreate: () => void;
}

export function ComposeCreateProjectCard({
  projectTitle,
  onProjectTitleChange,
  partTitle,
  onPartTitleChange,
  creating,
  onCreate,
}: ComposeCreateProjectCardProps) {
  return (
    <div className="mb-8 rounded-lg border bg-card p-6">
      <h2 className="text-lg font-semibold">Start a new project</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Name your project and first part. You will add scenes to the part, stitch them, then save the part.
        Start another part in the same project anytime.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Project name</span>
          <input
            type="text"
            value={projectTitle}
            onChange={(e) => onProjectTitleChange(e.target.value)}
            placeholder="e.g. Python for beginners"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Part name</span>
          <input
            type="text"
            value={partTitle}
            onChange={(e) => onPartTitleChange(e.target.value)}
            placeholder="e.g. Part 1 — Introduction"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
      </div>
      <button
        type="button"
        disabled={creating || !projectTitle.trim() || !partTitle.trim()}
        onClick={onCreate}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {creating ? <Loader2 size={16} className="animate-spin" /> : null}
        Create project &amp; start part
      </button>
    </div>
  );
}
