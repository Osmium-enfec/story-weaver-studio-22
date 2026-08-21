import { createFileRoute } from "@tanstack/react-router";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  localGetCourse,
  localGetCourseById,
  localListCourses,
  localSaveCourse,
} from "@/lib/local-courses-db";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { isAdminUser } from "@/lib/admin";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("get"), id: z.string().uuid() }),
  z.object({
    action: z.literal("save"),
    id: z.string().uuid().optional(),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    thumbnail_url: z.string().optional(),
  }),
]);

export const Route = createFileRoute("/api/courses")({
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
          return jsonResponse(await localListCourses(user.id, user.email, { asAdmin }));
        }

        if (data.action === "get") {
          const course = asAdmin
            ? await localGetCourseById(data.id)
            : await localGetCourse(user.id, user.email, data.id);
          if (!course) return jsonError("Course not found.", 404);
          return jsonResponse(course);
        }

        // Create vs update: only admins may create new courses. Users create episodes instead.
        const isCreate = !data.id || !(await localGetCourseById(data.id));
        if (isCreate && !asAdmin) {
          return jsonError(
            "Only admins can create courses. Ask an admin to add the course, then create episodes inside it.",
            403,
          );
        }

        const id = data.id ?? randomUUID();
        try {
          await localSaveCourse(user.id, {
            id,
            title: data.title,
            description: data.description,
            thumbnail_url: data.thumbnail_url,
          }, { asAdmin });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Save failed";
          const status = msg.includes("Not allowed") ? 403 : 500;
          return jsonError(msg, status);
        }
        return jsonResponse({ id, store: "sqlite" as const });
      },
    },
  },
});
