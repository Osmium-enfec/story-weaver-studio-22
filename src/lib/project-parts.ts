import type { Scene } from "@/components/VideoPlayer";
import type { PartBgmConfig } from "@/lib/part-bgm";

export interface ProjectPart {
  id: string;
  title: string;
  scenes: Scene[];
  masterAudioUrl: string;
  durationMs: number;
  /** Continuous background music for this part (preview + export). */
  bgm?: PartBgmConfig;
  thumbnail_url?: string | null;
  created_at: string;
  updated_at: string;
}

type ProjectLike = {
  parts?: unknown;
  workshop_draft?: unknown;
};

export function getProjectParts(project: ProjectLike | null | undefined): ProjectPart[] {
  if (!project) return [];
  if (Array.isArray(project.parts)) {
    return project.parts.filter(isProjectPart);
  }
  const wd = project.workshop_draft;
  if (wd && typeof wd === "object" && wd !== null && "composeParts" in wd) {
    const raw = (wd as { composeParts?: unknown }).composeParts;
    if (Array.isArray(raw)) return raw.filter(isProjectPart);
  }
  return [];
}

function isProjectPart(v: unknown): v is ProjectPart {
  if (!v || typeof v !== "object") return false;
  const p = v as ProjectPart;
  return (
    typeof p.id === "string" &&
    typeof p.title === "string" &&
    Array.isArray(p.scenes) &&
    typeof p.masterAudioUrl === "string"
  );
}

export function defaultPartTitle(existing: ProjectPart[]): string {
  return `Part ${existing.length + 1}`;
}

export function partThumb(part: ProjectPart): string | undefined {
  const s = part.scenes[0];
  if (!s) return part.thumbnail_url ?? undefined;
  return s.compositeThumbUrl ?? s.backgroundUrl ?? s.elements?.[0]?.mediaUrl ?? part.thumbnail_url ?? undefined;
}
