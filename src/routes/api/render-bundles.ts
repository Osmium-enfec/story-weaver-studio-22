import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { isAdminUser } from "@/lib/admin";
import { localGetProjectById } from "@/lib/local-projects-db";
import { userCanAccessPart } from "@/lib/project-parts";
import {
  BundleValidationError,
  bundleBaseUrl,
  buildBundlePayload,
  findPart,
} from "@/lib/render-bundle-build.server";
import {
  createRenderBundle,
  deleteRenderBundle,
  listRenderBundles,
  toListItem,
} from "@/lib/render-bundles-db";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("freeze"),
    projectId: z.string().min(1),
    partId: z.string().min(1),
  }),
  z.object({ action: z.literal("list"), all: z.boolean().optional() }),
  z.object({ action: z.literal("delete"), id: z.string().min(1) }),
]);

export const Route = createFileRoute("/api/render-bundles")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return await handlePost(request);
        } catch (e) {
          console.error("[render-bundles] POST failed", e);
          return jsonError(e instanceof Error ? e.message : "Render bundle request failed", 500);
        }
      },
    },
  },
});

async function handlePost(request: Request): Promise<Response> {
        let user;
        try {
          user = await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return jsonError("Invalid JSON", 400);
        }
        const parsed = Body.safeParse(raw);
        if (!parsed.success) {
          return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
        }
        const body = parsed.data;
        const admin = isAdminUser(user);

        if (body.action === "list") {
          const rows = await listRenderBundles(
            admin && body.all ? {} : { ownerUserId: user.id },
          );
          return jsonResponse({ bundles: rows.map(toListItem) });
        }

        if (body.action === "delete") {
          const rows = await listRenderBundles(admin ? {} : { ownerUserId: user.id });
          if (!rows.some((r) => r.id === body.id)) return jsonError("Not found", 404);
          await deleteRenderBundle(body.id);
          return jsonResponse({ ok: true });
        }

        const project = await localGetProjectById(body.projectId);
        if (!project) return jsonError("Episode not found", 404);
        const part = findPart(project, body.partId);
        if (!part) return jsonError("Part not found", 404);
        if (
          !admin &&
          project.user_id !== user.id &&
          !userCanAccessPart(part, { userId: user.id, userEmail: user.email })
        ) {
          return jsonError("Not allowed", 403);
        }

        try {
          const built = buildBundlePayload({
            episodeTitle: String(project.title ?? "Episode"),
            part,
            baseUrl: bundleBaseUrl(request),
          });
          const row = await createRenderBundle({
            projectId: project.id,
            partId: part.id,
            ownerUserId: project.user_id,
            ownerEmail:
              part.assignedUserEmail?.trim() || (await ownerEmail(project.user_id)),
            episodeTitle: String(project.title ?? "Episode"),
            partTitle: part.title,
            durationMs: built.durationMs,
            sceneCount: built.sceneCount,
            payload: built.payload,
          });
          return jsonResponse({ bundle: toListItem(row) });
        } catch (e) {
          if (e instanceof BundleValidationError) return jsonError(e.message, 422);
          return jsonError(e instanceof Error ? e.message : "Freeze failed", 500);
        }
}

async function ownerEmail(userId: string): Promise<string> {
  const { localGetUserById } = await import("@/lib/local-auth-db");
  return (await localGetUserById(userId))?.email ?? "(unknown)";
}
