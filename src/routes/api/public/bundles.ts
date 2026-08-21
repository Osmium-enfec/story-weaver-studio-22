import { createFileRoute } from "@tanstack/react-router";
import { hasValidRenderKey, renderKeyError } from "@/lib/render-key";
import { listRenderBundles, toListItem } from "@/lib/render-bundles-db";

/**
 * GET /api/public/bundles?status=ready
 * Render-key protected list of every part frozen with "Ready for HD".
 */
export const Route = createFileRoute("/api/public/bundles")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!hasValidRenderKey(request)) return renderKeyError();
        const status = new URL(request.url).searchParams.get("status") ?? "ready";
        const rows = await listRenderBundles({
          status:
            status === "all"
              ? "all"
              : status === "rendering" || status === "done" || status === "failed"
                ? status
                : "ready",
        });
        return Response.json({ bundles: rows.map(toListItem) });
      },
    },
  },
});
