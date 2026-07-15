import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import {
  localDeleteProject,
  localGetProject,
  localListProjects,
  localPruneProjectsExcept,
  localSaveProject,
} from "@/lib/local-projects-db";
import { getProjectParts } from "@/lib/project-parts";

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  script: z.string().max(20000).optional(),
  audio_mode: z.enum(["tts", "upload"]),
  scenes: z.any(),
  parts: z.any().optional(),
  thumbnail_url: z.string().optional(),
  workshop_draft: z.any().optional(),
});

const IdInput = z.object({ id: z.string().uuid() });

export type ProjectListItem = {
  id: string;
  title: string;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
  audio_mode: string;
  scene_count: number;
};

function normalizeProjectRecord(p: Record<string, unknown>): Record<string, unknown> {
  const parts = getProjectParts(p as { parts?: unknown; workshop_draft?: unknown });
  return { ...p, parts };
}

function pickLatestProjectId(items: ProjectListItem[]): string | null {
  if (items.length === 0) return null;
  const sorted = [...items].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );
  return sorted[0]?.id ?? null;
}

export const saveProject = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const isNew = !data.id;
    const id = data.id ?? randomUUID();

    localSaveProject(userId, { ...data, id });

    if (isNew) {
      localPruneProjectsExcept(userId, id);
    }

    return { id, store: "sqlite" as const };
  });

export const listProjects = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const all = localListProjects(userId);

    if (all.length === 0) return [];

    const keepId = pickLatestProjectId(all);
    if (!keepId) return [];

    if (all.length > 1) {
      localPruneProjectsExcept(userId, keepId);
    }

    const latest = all.find((p) => p.id === keepId);
    return latest ? [latest] : [];
  });

export const getProject = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    const local = localGetProject(context.userId, data.id);
    if (!local) throw new Error("Project not found.");
    return normalizeProjectRecord(local as unknown as Record<string, unknown>);
  });

export const deleteProject = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    localDeleteProject(context.userId, data.id);
    return { ok: true };
  });
