import { createFileRoute } from "@tanstack/react-router";
import { hasValidRenderKey, renderKeyError } from "@/lib/render-key";
import { putAsset } from "@/lib/object-storage";
import {
  claimNextRenderJob,
  getRenderJob,
  heartbeatRenderJob,
  listRenderJobs,
  toJobItem,
  updateRenderJob,
} from "@/lib/render-jobs-db";

/**
 * Render-machine API (all render-key protected):
 *   GET  /api/public/render/jobs            → read-only queue view
 *   GET  /api/public/render/:id             → the frozen HD job payload
 *   POST /api/public/render/claim           → atomically take the oldest waiting job
 *   POST /api/public/render/:id/progress    → heartbeat { progress, stage }; may reply { abort: true }
 *   POST /api/public/render/:id/fail        → { error }
 *   PUT  /api/public/render/:id/output      → raw MP4 body; stores and links the render
 */
export const Route = createFileRoute("/api/public/render/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!hasValidRenderKey(request)) return renderKeyError();
        const { id } = splat(params._splat);
        if (!id || id === "jobs") {
          const status = new URL(request.url).searchParams.get("status") ?? "active";
          const rows = await listRenderJobs({
            status: status as "all",
          });
          return Response.json({ jobs: rows.map(toJobItem) });
        }
        const job = await getRenderJob(id);
        if (!job) return json({ error: "Render job not found" }, 404);
        return Response.json(jobPayload(job));
      },

      POST: async ({ params, request }) => {
        if (!hasValidRenderKey(request)) return renderKeyError();
        const { id, sub } = splat(params._splat);

        if (id === "claim") {
          let body: { machine?: string } = {};
          try {
            body = (await request.json()) as typeof body;
          } catch {
            body = {};
          }
          const machine = (body.machine ?? "").trim().slice(0, 80) || "unnamed-machine";
          const job = await claimNextRenderJob(machine);
          if (!job) return Response.json({ job: null });
          return Response.json({ job: jobPayload(job) });
        }

        if (!id) return json({ error: "Not found" }, 404);

        if (sub === "progress") {
          let body: { progress?: number; stage?: string; machine?: string } = {};
          try {
            body = (await request.json()) as typeof body;
          } catch {
            body = {};
          }
          const job = await heartbeatRenderJob(id, {
            progress:
              typeof body.progress === "number"
                ? body.progress > 1
                  ? body.progress / 100
                  : body.progress
                : undefined,
            stage: typeof body.stage === "string" ? body.stage.slice(0, 120) : undefined,
            machine: typeof body.machine === "string" ? body.machine.slice(0, 80) : undefined,
          });
          if (!job) return json({ error: "Render job not found" }, 404);
          return Response.json({
            ok: true,
            status: job.status,
            abort: job.status === "cancelled",
          });
        }

        if (sub === "fail") {
          let body: { error?: string } = {};
          try {
            body = (await request.json()) as typeof body;
          } catch {
            body = {};
          }
          const message = (body.error ?? "Render failed").slice(0, 2000);
          // "Another job is ahead in the queue" means the machine skipped this
          // one on purpose — it belongs back in the queue, not in failures.
          const skipped = /ahead in the queue/i.test(message);
          const job = await updateRenderJob(
            id,
            skipped
              ? { status: "queued", stage: "queued", progress: 0, machine: null, error: null }
              : { status: "failed", stage: "failed", error: message },
          );
          if (!job) return json({ error: "Render job not found" }, 404);
          return Response.json({ ok: true });
        }

        return json({ error: "Not found" }, 404);
      },

      PUT: async ({ params, request }) => {
        if (!hasValidRenderKey(request)) return renderKeyError();
        const { id, sub } = splat(params._splat);
        if (!id || sub !== "output") return json({ error: "Not found" }, 404);
        const job = await getRenderJob(id);
        if (!job) return json({ error: "Render job not found" }, 404);

        const bytes = Buffer.from(await request.arrayBuffer());
        if (bytes.byteLength === 0) return json({ error: "Empty body" }, 400);

        const payload = job.payload as { filename?: string };
        const filename = (payload.filename ?? `${job.id}.mp4`).replace(/[^\w.\- ]+/g, "");
        const url = await putAsset({
          kind: "project",
          relPath: `renders/${job.id}/${filename}`,
          body: bytes,
          contentType: "video/mp4",
        });
        const updated = await updateRenderJob(id, {
          status: "done",
          progress: 1,
          stage: "done",
          outputUrl: url,
          error: null,
        });
        return Response.json({ ok: true, outputUrl: updated?.output_url ?? url });
      },
    },
  },
});

function jobPayload(job: Awaited<ReturnType<typeof getRenderJob>>) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    episodeTitle: job.episode_title,
    partTitle: job.part_title,
    requestedBy: job.requested_by_email,
    durationMs: job.duration_ms,
    sceneCount: job.scene_count,
    createdAt: job.created_at,
    outputUrl: job.output_url,
    ...(job.payload as Record<string, unknown>),
  };
}

function splat(value: string | undefined): { id: string | null; sub: string | null } {
  const parts = (value ?? "").split("/").filter(Boolean);
  return { id: parts[0] ?? null, sub: parts[1] ?? null };
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
