import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import {
  getReview,
  listCourseReviews,
  partComposerEmail,
  upsertReview,
} from "@/lib/review-db";
import { isAdminUser } from "@/lib/admin";
import {
  REVIEW_FIELDS,
  canEditReviewField,
  type ReviewField,
} from "@/lib/review-permissions";

const STATUS = z.string().max(50);
const TEXT = z.string().max(20000);

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), courseId: z.string().min(1) }),
  z.object({ action: z.literal("grants") }),
  z.object({
    action: z.literal("save"),
    projectId: z.string().min(1),
    partId: z.string().min(1),
    courseId: z.string().min(1).nullable().optional(),
    script_status: STATUS.optional(),
    recording_status: STATUS.optional(),
    review_status: STATUS.optional(),
    issues_found: TEXT.optional(),
    correction_status: STATUS.optional(),
    assignee_email: z.string().max(200).optional(),
    review_doc_url: z.string().max(2000).optional(),
    review_doc_name: z.string().max(300).optional(),
    rendered_uploaded: STATUS.optional(),
  }),
]);

export const Route = createFileRoute("/api/reviews")({
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
          return jsonError(
            parsed.error.issues[0]?.message ?? "Invalid request",
            400,
          );
        }
        const data = parsed.data;

        try {
          if (data.action === "list") {
            return jsonResponse(await listCourseReviews(data.courseId));
          }

          const { getReviewGrants } = await import("@/lib/review-access-db");
          if (data.action === "grants") {
            return jsonResponse({
              email: user.email,
              isAdmin: isAdminUser(user),
              fields: await getReviewGrants(user.email),
            });
          }

          const rec = data as Record<string, unknown>;
          const touched = REVIEW_FIELDS.filter((f) =>
            f === "review_doc"
              ? rec.review_doc_url !== undefined ||
                rec.review_doc_name !== undefined
              : rec[f] !== undefined,
          ) as ReviewField[];
          if (touched.length === 0) return jsonError("Nothing to update", 400);

          const actor = {
            email: user.email,
            isAdmin: isAdminUser(user),
            grantedFields: await getReviewGrants(user.email),
          };
          // Admins can edit everything — skip the expensive lookups
          // (the parts JSON blob is large and can blow the request budget).
          const composerEmail = actor.isAdmin
            ? null
            : await partComposerEmail(data.projectId, data.partId);
          const existing = actor.isAdmin
            ? null
            : await getReview(data.projectId, data.partId);
          const ctx = {
            composerEmail,
            reviewAssigneeEmail: existing?.assignee_email ?? null,
          };
          const denied = touched.filter(
            (f) => !canEditReviewField(f, actor, ctx),
          );
          if (denied.length > 0) {
            return jsonError(
              `You are not allowed to edit: ${denied.join(", ")}`,
              403,
            );
          }

          const row = await upsertReview({
            project_id: data.projectId,
            part_id: data.partId,
            course_id: data.courseId ?? null,
            script_status: data.script_status,
            recording_status: data.recording_status,
            review_status: data.review_status,
            issues_found: data.issues_found,
            correction_status: data.correction_status,
            assignee_email: data.assignee_email,
            review_doc_url: data.review_doc_url,
            review_doc_name: data.review_doc_name,
            rendered_uploaded: data.rendered_uploaded,
            updated_by_email: user.email,
          });
          return jsonResponse(row);
        } catch (e) {
          return jsonError(
            e instanceof Error ? e.message : "Review request failed",
            500,
          );
        }
      },
    },
  },
});
