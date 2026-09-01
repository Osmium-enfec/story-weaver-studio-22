import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { listCourseReviews, upsertReview } from "@/lib/review-db";

const STATUS = z.string().max(50);
const TEXT = z.string().max(5000);

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), courseId: z.string().min(1) }),
  z.object({
    action: z.literal("save"),
    projectId: z.string().min(1),
    courseId: z.string().min(1).nullable().optional(),
    parts_checked: TEXT.optional(),
    review_status: STATUS.optional(),
    issues_found: TEXT.optional(),
    correction_status: STATUS.optional(),
    assignee_email: z.string().max(200).optional(),
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
          const row = await upsertReview({
            project_id: data.projectId,
            course_id: data.courseId ?? null,
            parts_checked: data.parts_checked,
            review_status: data.review_status,
            issues_found: data.issues_found,
            correction_status: data.correction_status,
            assignee_email: data.assignee_email,
            rendered_uploaded: data.rendered_uploaded,
            updated_by_email: user.email,
          });
          return jsonResponse(row);
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : "Review request failed", 500);
        }
      },
    },
  },
});
