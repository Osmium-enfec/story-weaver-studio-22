import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import {
  localDeleteProject,
  localGetProject,
  localListProjects,
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

export type ProjectRecord = {
  id: string;
  user_id?: string;
  title: string;
  script?: string | null;
  audio_mode: string;
  thumbnail_url?: string | null;
  created_at?: string;
  updated_at?: string;
  scenes?: any;
  parts?: any;
  workshop_draft?: any;
};

function normalizeProjectRecord(p: Record<string, any>): ProjectRecord {
  const parts = getProjectParts(p as { parts?: unknown; workshop_draft?: unknown });
  return { ...p, parts } as ProjectRecord;
}

export const saveProject = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const id = data.id ?? randomUUID();

    localSaveProject(userId, { ...data, id, scenes: data.scenes ?? [] });

    return { id, store: "sqlite" as const };
  });

export const listProjects = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    return localListProjects(context.userId);
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
