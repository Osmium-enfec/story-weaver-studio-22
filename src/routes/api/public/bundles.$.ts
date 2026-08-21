import { createFileRoute } from "@tanstack/react-router";
import { hasValidRenderKey, renderKeyError } from "@/lib/render-key";
import { getRenderBundle, updateRenderBundle } from "@/lib/render-bundles-db";
import { putAsset } from "@/lib/object-storage";

/**
 * Render-key protected single-bundle API for the external HD render Mac:
 *   GET    /api/public/bundles/:id            → the exact HD job payload
 *   POST   /api/public/bundles/:id/status     → { status: rendering|done|failed, error? }
 *   PUT    /api/public/bundles/:id/output     → raw MP4 body; stores and links the render
 */
export const Route = createFileRoute("/api/public/bundles/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!hasValidRenderKey(request)) return renderKeyError();
        const { id } = splat(params._splat);
        const row = id ? await getRenderBundle(id) : null;
        if (!row) return json({ error: "Bundle not found" }, 404);
        return Response.json({
          id: row.id,
          status: row.status,
          episodeTitle: row.episode_title,
          partTitle: row.part_title,
          ownerEmail: row.owner_email,
          durationMs: row.duration_ms,
          sceneCount: row.scene_count,
          readyAt: row.ready_at,
          outputUrl: row.output_url,
          ...(row.payload as Record<string, unknown>),
        });
      },

      POST: async ({ params, request }) => {
        if (!hasValidRenderKey(request)) return renderKeyError();
        const { id, sub } = splat(params._splat);
        if (!id || sub !== "status") return json({ error: "Not found" }, 404);
        let body: { status?: string; error?: string | null };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        const status = body.status;
        if (
          status !== "ready" &&
          status !== "rendering" &&
          status !== "done" &&
          status !== "failed"
        ) {
          return json({ error: "status must be ready|rendering|done|failed" }, 400);
        }
        const row = await updateRenderBundle(id, {
          status,
          error: body.error ?? null,
        });
        if (!row) return json({ error: "Bundle not found" }, 404);
        return Response.json({ ok: true, status: row.status });
      },

      PUT: async ({ params, request }) => {
        if (!hasValidRenderKey(request)) return renderKeyError();
        const { id, sub } = splat(params._splat);
        if (!id || sub !== "output") return json({ error: "Not found" }, 404);
        const row = await getRenderBundle(id);
        if (!row) return json({ error: "Bundle not found" }, 404);

        const bytes = Buffer.from(await request.arrayBuffer());
        if (bytes.byteLength === 0) return json({ error: "Empty body" }, 400);

        const payload = row.payload as { filename?: string };
        const filename = (payload.filename ?? `${row.id}.mp4`).replace(
          /[^\w.\- ]+/g,
          "",
        );
        const url = await putAsset({
          kind: "project",
          relPath: `renders/${row.id}/${filename}`,
          body: bytes,
          contentType: "video/mp4",
        });
        const updated = await updateRenderBundle(id, {
          status: "done",
          outputUrl: url,
          error: null,
        });
        return Response.json({ ok: true, outputUrl: updated?.output_url ?? url });
      },
    },
  },
});

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
