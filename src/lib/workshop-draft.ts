import type { ScenePlan } from "@/lib/explainer.functions";
import type { Scene } from "@/components/VideoPlayer";
import type { SceneBackground } from "@/lib/scene-background";
import type { WorkshopStep } from "@/lib/scene-workshop-steps";

export type WorkshopInputMode = "script" | "audio";

/** Serializable workshop state — restored after refresh. */
export interface WorkshopDraft {
  mode: WorkshopInputMode;
  script: string;
  scriptPlans: ScenePlan[];
  activePlanIndex: number;
  workshopScene: Scene | null;
  workshopSteps: WorkshopStep[];
  background: SceneBackground;
  sceneSaved: boolean;
  updatedAt: number;
}

const LOCAL_PREFIX = "sws:workshop:";

export function localDraftKey(projectId?: string | null): string {
  return `${LOCAL_PREFIX}${projectId ?? "local"}`;
}

export function readLocalWorkshopDraft(projectId?: string | null): WorkshopDraft | null {
  try {
    const raw = localStorage.getItem(localDraftKey(projectId));
    if (!raw) return null;
    return JSON.parse(raw) as WorkshopDraft;
  } catch {
    return null;
  }
}

export function writeLocalWorkshopDraft(projectId: string | null | undefined, draft: WorkshopDraft): void {
  try {
    localStorage.setItem(localDraftKey(projectId), JSON.stringify({ ...draft, updatedAt: Date.now() }));
  } catch (e) {
    console.warn("[workshop-draft] localStorage full or blocked", e);
  }
}

export function parseWorkshopDraft(raw: unknown): WorkshopDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<WorkshopDraft>;
  if (typeof d.script !== "string") return null;
  return {
    mode: d.mode === "audio" ? "audio" : "script",
    script: d.script,
    scriptPlans: Array.isArray(d.scriptPlans) ? d.scriptPlans : [],
    activePlanIndex: typeof d.activePlanIndex === "number" ? d.activePlanIndex : 0,
    workshopScene: (d.workshopScene as Scene | null) ?? null,
    workshopSteps: Array.isArray(d.workshopSteps) ? d.workshopSteps : [],
    background: (d.background as SceneBackground) ?? { kind: "video", url: "/bg-loop.mp4" },
    sceneSaved: !!d.sceneSaved,
    updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : 0,
  };
}

/** Pick newest draft between server payload and localStorage. */
export function mergeWorkshopDrafts(
  server: WorkshopDraft | null,
  local: WorkshopDraft | null,
): WorkshopDraft | null {
  if (!server && !local) return null;
  if (!server) return local;
  if (!local) return server;
  return (local.updatedAt >= server.updatedAt ? local : server);
}

export function buildWorkshopDraft(input: Omit<WorkshopDraft, "updatedAt">): WorkshopDraft {
  return { ...input, updatedAt: Date.now() };
}
