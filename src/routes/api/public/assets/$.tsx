import { createFileRoute } from "@tanstack/react-router";
import path from "node:path";
import { contentTypeForExt } from "@/lib/asset-mime";
import { readAsset } from "@/lib/object-storage";
import { hasValidRenderKey, renderKeyError } from "@/lib/render-key";

/**
 * Render-key protected asset download for the external HD render Mac.
 * `/api/public/assets/project/<rel>` and `/api/public/assets/app/<rel>`.
 */
export const Route = createFileRoute("/api/public/assets/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!hasValidRenderKey(request)) return renderKeyError();

        const splat = params._splat ?? "";
        const slash = splat.indexOf("/");
        const kindRaw = slash === -1 ? "" : splat.slice(0, slash);
        const rel = slash === -1 ? "" : splat.slice(slash + 1);
        if (!rel || rel.includes("..") || (kindRaw !== "project" && kindRaw !== "app")) {
          return new Response("Not found", { status: 404 });
        }

        const ext = path.extname(rel).slice(1);
        const result = await readAsset({
          kind: kindRaw === "app" ? "app" : "project",
          relPath: rel,
          contentType: contentTypeForExt(ext),
          rangeHeader: request.headers.get("range"),
        });
        if (!result) return new Response("Not found", { status: 404 });

        return new Response(result.body, {
          status: result.status,
          headers: result.headers,
        });
      },
    },
  },
});
