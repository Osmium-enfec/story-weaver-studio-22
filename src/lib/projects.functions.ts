import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import {
  localDeleteProject,
  localGetProject,
  localGetProjectById,
  localListProjects,
  localSaveProject,
} from "@/lib/local-projects-db";
import { getProjectParts } from "@/lib/project-parts";
import { isAdminEmail } from "@/lib/admin";

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  script: z.string().max(20000).optional(),
  audio_mode: z.enum(["tts", "upload"]),
  scenes: z.any(),
  parts: z.any().optional(),
  thumbnail_url: z.string().optional(),
  workshop_draft: z.any().optional(),
  course_id: z.string().uuid().nullable().optional(),
  allow_scene_shrink: z.boolean().optional(),
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
  part_count?: number;
  course_id?: string | null;
};

function normalizeProjectRecord(p: Record<string, unknown>): Record<string, unknown> {
  const parts = getProjectParts(p as { parts?: unknown; workshop_draft?: unknown });
  return { ...p, parts };
}

export const saveProject = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }) => {
    const { userId, email } = context;
    const id = data.id ?? randomUUID();

    await localSaveProject(
      userId,
      email,
      { ...data, id, scenes: data.scenes ?? [] },
      { asAdmin: isAdminEmail(email) },
    );

    return { id, store: "sqlite" as const };
  });

export const listProjects = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const asAdmin = isAdminEmail(context.email);
    return await localListProjects(context.userId, context.email, {
      asAdmin,
      requireCourse: !asAdmin,
    });
  });

export const getProject = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    const asAdmin = isAdminEmail(context.email);
    const local = asAdmin
      ? await localGetProjectById(data.id)
      : await localGetProject(context.userId, context.email, data.id);
    if (!local) throw new Error("Project not found.");
    // createServerFn requires the return type to be serializable; `unknown` breaks
    // the type-level check even though the runtime value is JSON-safe.
    return normalizeProjectRecord(local as any) as any;
  });

export const deleteProject = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    await localDeleteProject(context.userId, data.id);
    return { ok: true };
  });
