import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiAdmin } from "@/lib/api-auth";
import { isAdminEmail } from "@/lib/admin";
import { ensureBootstrapAdmins } from "@/lib/ensure-admin";
import {
  localActiveSessionCount,
  localDeleteUser,
  localListUsers,
} from "@/lib/local-auth-db";
import {
  localCourseCountByUser,
  localEpisodeCountByUser,
  localEpisodeTotalCount,
  localListAllCourses,
} from "@/lib/local-courses-db";
import { localListAssignments, localSavedSceneCountsByUser } from "@/lib/local-projects-db";
import { listAllExportJobs } from "@/lib/native-export-jobs";

const DeleteBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deleteUser"), userId: z.string().uuid() }),
  z.object({
    action: z.literal("setReviewAccess"),
    email: z.string().email(),
    fields: z.array(z.string().max(40)).max(20),
  }),
]);

export const Route = createFileRoute("/api/admin")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await ensureBootstrapAdmins();
        try {
          await requireApiAdmin(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        const url = new URL(request.url);
        // Review-access matrix for the admin "Review access" tab.
        if (url.searchParams.get("reviewAccess") === "1") {
          const { listReviewGrants } = await import("@/lib/review-access-db");
          const [users, grants] = await Promise.all([
            localListUsers(),
            listReviewGrants(),
          ]);
          return jsonResponse({
            users: users.map((u) => ({
              id: u.id,
              email: u.email,
              isAdmin: isAdminEmail(u.email),
              fields: grants[u.email.trim().toLowerCase()] ?? [],
            })),
          });
        }
        // Lightweight users list for assign dropdowns (no courses/exports scan).
        if (url.searchParams.get("usersOnly") === "1") {
          const users = (await localListUsers()).map((u) => ({
            id: u.id,
            email: u.email,
            created_at: u.created_at,
            isAdmin: isAdminEmail(u.email),
          }));
          return jsonResponse({ users });
        }

        const users = await localListUsers();
        const emailById = new Map(users.map((u) => [u.id, u.email]));
        const courseCountByUser = await localCourseCountByUser();
        const episodeCountByUser = await localEpisodeCountByUser();

        const courses = (await localListAllCourses()).map((c: { user_id: string }) => ({
          ...c,
          userEmail: emailById.get(c.user_id) ?? "(unknown user)",
        }));

        const assignments = (await localListAssignments()).map(
          (a: { assignedUserEmail?: string | null; assignedUserId: string }) => ({
          ...a,
          assignedUserEmail:
            a.assignedUserEmail ||
            emailById.get(a.assignedUserId) ||
            "(unknown user)",
        }),
        );

        // Disk scan only — no prune on admin poll (prune is per-user Export page).
        const exports = listAllExportJobs().map((j) => ({
          ...j,
          userEmail: emailById.get(j.userId) ?? "(unknown user)",
        }));

        const activeExports = exports.filter(
          (e) => e.status === "running" || e.status === "queued",
        );

        const sceneCountsByUser = await localSavedSceneCountsByUser();
        const totalSavedScenes = [...sceneCountsByUser.values()].reduce(
          (sum, n) => sum + n,
          0,
        );

        const usersWithStats = await Promise.all(
          users.map(async (u) => ({
            ...u,
            isAdmin: isAdminEmail(u.email),
            activeSessions: await localActiveSessionCount(u.id),
            courseCount: courseCountByUser.get(u.id) ?? 0,
            episodeCount: episodeCountByUser.get(u.id) ?? 0,
            assignmentCount: assignments.filter(
              (a: { assignedUserId: string }) => a.assignedUserId === u.id,
            ).length,
            savedSceneCount: sceneCountsByUser.get(u.id) ?? 0,
            exportJobsRunning: activeExports.filter((e) => e.userId === u.id).length,
          })),
        );

        return jsonResponse({
          users: usersWithStats,
          courses,
          assignments,
          exports,
          summary: {
            userCount: users.length,
            courseCount: courses.length,
            episodeCount: await localEpisodeTotalCount(),
            assignmentCount: assignments.length,
            exportJobCount: exports.length,
            activeExports: activeExports.length,
            savedSceneCount: totalSavedScenes,
          },
        });
      },

      POST: async ({ request }) => {
        await ensureBootstrapAdmins();
        let admin;
        try {
          admin = await requireApiAdmin(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError("Invalid JSON", 400);
        }

        const parsed = DeleteBody.safeParse(body);
        if (!parsed.success) {
          return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
        }

        if (parsed.data.action === "setReviewAccess") {
          const { setReviewGrants } = await import("@/lib/review-access-db");
          const { REVIEW_FIELDS } = await import("@/lib/review-permissions");
          const fields = parsed.data.fields.filter((f) =>
            (REVIEW_FIELDS as string[]).includes(f),
          ) as import("@/lib/review-permissions").ReviewField[];
          try {
            return jsonResponse({
              ok: true,
              fields: await setReviewGrants(parsed.data.email, fields),
            });
          } catch (e: unknown) {
            return jsonError(
              e instanceof Error ? e.message : "Could not save access",
              500,
            );
          }
        }

        try {
          await localDeleteUser(parsed.data.userId, admin.id);
          return jsonResponse({ ok: true });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Delete failed";
          const status =
            msg.includes("Cannot delete") || msg.includes("cannot delete")
              ? 403
              : msg.includes("not found")
                ? 404
                : 400;
          return jsonError(msg, status);
        }
      },
    },
  },
});
