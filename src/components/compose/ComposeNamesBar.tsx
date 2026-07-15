import { Link } from "@tanstack/react-router";
import { FolderOpen } from "lucide-react";

interface ComposeNamesBarProps {
  projectId?: string;
  projectTitle: string;
  onProjectTitleChange: (v: string) => void;
  onProjectTitleSave: () => void;
  partTitle: string;
  onPartTitleChange: (v: string) => void;
  onPartTitleSave: () => void;
  sceneTitle: string;
  onSceneTitleChange: (v: string) => void;
}

export function ComposeNamesBar({
  projectId,
  projectTitle,
  onProjectTitleChange,
  onProjectTitleSave,
  partTitle,
  onPartTitleChange,
  onPartTitleSave,
  sceneTitle,
  onSceneTitleChange,
}: ComposeNamesBarProps) {
  if (!projectId) return null;

  return (
    <div className="mb-6 rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Names</p>
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <FolderOpen size={12} /> All projects
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium text-muted-foreground">Project</span>
          <input
            type="text"
            value={projectTitle}
            onChange={(e) => onProjectTitleChange(e.target.value)}
            onBlur={onProjectTitleSave}
            placeholder="Project name"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium text-muted-foreground">Part</span>
          <input
            type="text"
            value={partTitle}
            onChange={(e) => onPartTitleChange(e.target.value)}
            onBlur={onPartTitleSave}
            placeholder="Name this part"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium text-muted-foreground">Scene</span>
          <input
            type="text"
            value={sceneTitle}
            onChange={(e) => onSceneTitleChange(e.target.value)}
            placeholder="Scene title for this compose"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
      </div>
    </div>
  );
}
