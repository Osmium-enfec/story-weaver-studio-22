import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { isAdminUser } from "@/lib/admin";
import { localGetProjectById } from "@/lib/local-projects-db";
import { localGetCourseById } from "@/lib/local-courses-db";
import { normalizeCourseSettings, resolveCourseTemplateTheme } from "@/lib/course-settings";
import { DEFAULT_BACKGROUND, type SceneBackground } from "@/lib/scene-background";
import { getReview } from "@/lib/review-db";
import { normalizeWorkflowStatus } from "@/lib/review-workflow";
import {
  BundleValidationError,
  bundleBaseUrl,
  buildBundlePayload,
  findPart,
} from "@/lib/render-bundle-build.server";
import {
  createRenderJob,
  deleteRenderJob,
  getRenderJob,
  listRenderJobs,
  toJobItem,
  updateRenderJob,
} from "@/lib/render-jobs-db";
import type { ProjectPart } from "@/lib/project-parts";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("queue"),
    projectId: z.string().min(1),
    partId: z.string().min(1),
  }),
  z.object({ action: z.literal("list"), courseId: z.string().optional() }),
  z.object({ action: z.literal("stop"), id: z.string().min(1) }),
  z.object({ action: z.literal("delete"), id: z.string().min(1) }),
  z.object({ action: z.literal("delete-video"), id: z.string().min(1) }),
  z.object({ action: z.literal("requeue"), id: z.string().min(1) }),
]);

export const Route = createFileRoute("/api/render-jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return await handlePost(request);
        } catch (e) {
          console.error("[render-jobs] POST failed", e);
          return jsonError(
            e instanceof Error ? e.message : "Render job request failed",
            500,
          );
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
    const rows = await listRenderJobs(
      body.courseId ? { courseId: body.courseId } : {},
    );
    return jsonResponse({ jobs: rows.map(toJobItem) });
  }

  if (body.action !== "queue") {
    const job = await getRenderJob(body.id);
    if (!job) return jsonError("Render job not found", 404);
    const owns = job.requested_by_user_id === user.id;

    if (body.action === "stop") {
      if (!owns && !admin) return jsonError("Not allowed", 403);
      if (job.status === "done") return jsonError("Already rendered", 409);
      await updateRenderJob(job.id, {
        status: "cancelled",
        stage: "stopped",
        error: null,
      });
      return jsonResponse({ ok: true });
    }

    if (body.action === "delete") {
      if (!owns && !admin) return jsonError("Not allowed", 403);
      if (job.status === "done" && !admin) {
        return jsonError("Only an admin can remove a finished render", 403);
      }
      await deleteRenderJob(job.id);
      return jsonResponse({ ok: true });
    }

    if (body.action === "delete-video") {
      if (!admin) return jsonError("Admins only", 403);
      await updateRenderJob(job.id, {
        status: "cancelled",
        stage: "video removed",
        outputUrl: null,
        progress: 0,
      });
      return jsonResponse({ ok: true });
    }

    // requeue
    if (!owns && !admin) return jsonError("Not allowed", 403);
    const requeued = await updateRenderJob(job.id, {
      status: "queued",
      progress: 0,
      stage: "",
      machine: null,
      error: null,
      outputUrl: null,
    });
    return jsonResponse({ job: toJobItem(requeued ?? job) });
  }

  // --- queue a part ---
  const project = await localGetProjectById(body.projectId);
  if (!project) return jsonError("Episode not found", 404);
  const part = findPart(project, body.partId);
  if (!part) return jsonError("Part not found", 404);

  if (!admin && !isPartReviewer(part, user.email)) {
    return jsonError("Only the reviewer or an admin can send a part to HD render", 403);
  }

  const review = await getReview(project.id, part.id);
  const stage = normalizeWorkflowStatus(review?.workflow_status);
  if (stage !== "reviewed" && !admin) {
    return jsonError("This part is not reviewed yet", 422);
  }

  try {
    const course = project.course_id ? await localGetCourseById(project.course_id) : null;
    const courseSettings = normalizeCourseSettings(course?.settings);
    const built = buildBundlePayload({
      episodeTitle: String(project.title ?? "Episode"),
      part,
      baseUrl: bundleBaseUrl(request),
      background: await courseBackground(project.course_id ?? null),
      templateTheme: resolveCourseTemplateTheme(courseSettings, course?.title),
    });
    const row = await createRenderJob({
      courseId: project.course_id ?? null,
      projectId: project.id,
      partId: part.id,
      episodeTitle: String(project.title ?? "Episode"),
      partTitle: part.title,
      requestedByUserId: user.id,
      requestedByEmail: user.email,
      durationMs: built.durationMs,
      sceneCount: built.sceneCount,
      payload: built.payload,
    });
    return jsonResponse({ job: toJobItem(row) });
  } catch (e) {
    if (e instanceof BundleValidationError) return jsonError(e.message, 422);
    throw e;
  }
}

function isPartReviewer(part: ProjectPart, email: string): boolean {
  const mine = email.trim().toLowerCase();
  const reviewer = (part as { reviewerUserEmail?: string | null }).reviewerUserEmail;
  return Boolean(reviewer && reviewer.trim().toLowerCase() === mine);
}

/** Background the course theme dictates, so HD renders match the preview. */
async function courseBackground(courseId: string | null): Promise<SceneBackground> {
  if (!courseId) return DEFAULT_BACKGROUND;
  try {
    const course = await localGetCourseById(courseId);
    const settings = normalizeCourseSettings(course?.settings);
    if (settings.backgroundPreset === "plain-white") return { kind: "whiteboard" };
    if (settings.bgLoopUrl) return { kind: "video", url: settings.bgLoopUrl };
  } catch (e) {
    console.error("[render-jobs] course background lookup failed", e);
  }
  return DEFAULT_BACKGROUND;
}
