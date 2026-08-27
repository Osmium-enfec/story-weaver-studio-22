import { createFileRoute } from "@tanstack/react-router";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  localAssignEpisode,
  localAssignPart,
  localDeleteProject,
  localGetProject,
  localGetProjectById,
  localListProjects,
  localSaveProject,
} from "@/lib/local-projects-db";
import { localGetUserById } from "@/lib/local-auth-db";
import { getProjectParts } from "@/lib/project-parts";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { isAdminUser } from "@/lib/admin";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    /** When set, filter episodes by course. null = unassigned only. */
    course_id: z.string().uuid().nullable().optional(),
  }),
  z.object({ action: z.literal("get"), id: z.string().uuid() }),
  z.object({
    action: z.literal("save"),
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
    preserve_part_scenes: z.boolean().optional(),
  }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }),
  z.object({
    action: z.literal("assignEpisode"),
    id: z.string().uuid(),
    /** null clears assignment. */
    assigned_user_id: z.string().uuid().nullable(),
  }),
  z.object({
    action: z.literal("assignPart"),
    id: z.string().uuid(),
    part_id: z.string().uuid(),
    assigned_user_id: z.string().uuid().nullable(),
  }),
]);

function normalizeProjectRecord(p: Record<string, unknown>): Record<string, unknown> {
  const parts = getProjectParts(p as { parts?: unknown; workshop_draft?: unknown });
  return { ...p, parts };
}

async function resolveAssignee(
  userId: string | null,
): Promise<{ userId: string; email: string } | null> {
  if (!userId) return null;
  const u = await localGetUserById(userId);
  if (!u) throw new Error("User not found.");
  return { userId: u.id, email: u.email };
}

export const Route = createFileRoute("/api/projects")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let user;
        try {
          user = await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError("Invalid JSON", 400);
        }

        const parsed = Body.safeParse(body);
        if (!parsed.success) {
          return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
        }

        const data = parsed.data;
        const asAdmin = isAdminUser(user);

        if (data.action === "list") {
          // Unassigned episodes (no course) are admin-only.
          if (data.course_id === null && !asAdmin) {
            return jsonResponse([]);
          }
          if (data.course_id !== undefined) {
            return jsonResponse(
              await localListProjects(user.id, user.email, {
                courseId: data.course_id,
                asAdmin,
              }),
            );
          }
          return jsonResponse(
            await localListProjects(user.id, user.email, {
              asAdmin,
              // Non-admins only see episodes that belong to a course.
              requireCourse: !asAdmin,
            }),
          );
        }

        if (data.action === "get") {
          const local = asAdmin
            ? await localGetProjectById(data.id)
            : await localGetProject(user.id, user.email, data.id);
          if (!local) return jsonError("Episode not found.", 404);
          return jsonResponse(normalizeProjectRecord(local as unknown as Record<string, unknown>));
        }

        if (data.action === "assignEpisode") {
          if (!asAdmin) return jsonError("Admin only.", 403);
          try {
            const assignee = await resolveAssignee(data.assigned_user_id);
            const updated = await localAssignEpisode(data.id, assignee);
            return jsonResponse(
              normalizeProjectRecord(updated as unknown as Record<string, unknown>),
            );
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Assign failed", 400);
          }
        }

        if (data.action === "assignPart") {
          if (!asAdmin) return jsonError("Admin only.", 403);
          try {
            const assignee = await resolveAssignee(data.assigned_user_id);
            const updated = await localAssignPart(data.id, data.part_id, assignee);
            return jsonResponse(
              normalizeProjectRecord(updated as unknown as Record<string, unknown>),
            );
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Assign failed", 400);
          }
        }

        if (data.action === "save") {
          const id = data.id ?? randomUUID();
          try {
            await localSaveProject(
              user.id,
              user.email,
              {
                ...data,
                id,
                scenes: data.scenes ?? [],
                course_id: data.course_id,
              },
              { asAdmin },
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : "Save failed";
            const status = msg.includes("Not allowed") ? 403 : 500;
            return jsonError(msg, status);
          }
          return jsonResponse({ id, store: "sqlite" as const });
        }

        try {
          await localDeleteProject(user.id, data.id);
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : "Delete failed", 500);
        }
        return jsonResponse({ ok: true });
      },
    },
  },
});
