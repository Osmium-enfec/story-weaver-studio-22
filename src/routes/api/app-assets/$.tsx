import { createFileRoute } from "@tanstack/react-router";
import path from "node:path";
import { contentTypeForExt } from "@/lib/asset-mime";
import { readAsset } from "@/lib/object-storage";

export const Route = createFileRoute("/api/app-assets/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const rel = params._splat ?? "";
        if (!rel || rel.includes("..")) {
          return new Response("Not found", { status: 404 });
        }

        const ext = path.extname(rel).slice(1);
        const contentType = contentTypeForExt(ext);
        const result = await readAsset({
          kind: "app",
          relPath: rel,
          contentType,
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
