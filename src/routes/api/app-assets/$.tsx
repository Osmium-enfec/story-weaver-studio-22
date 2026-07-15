import { createFileRoute } from "@tanstack/react-router";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { contentTypeForExt } from "@/lib/asset-mime";

function appAssetsRoot(): string {
  return path.join(process.cwd(), ".data", "app-assets");
}

export const Route = createFileRoute("/api/app-assets/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const rel = params._splat ?? "";
        if (!rel || rel.includes("..")) {
          return new Response("Not found", { status: 404 });
        }

        const filePath = path.join(appAssetsRoot(), rel);
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(appAssetsRoot()))) {
          return new Response("Forbidden", { status: 403 });
        }
        if (!existsSync(resolved)) {
          return new Response("Not found", { status: 404 });
        }

        const ext = path.extname(resolved).slice(1);
        const body = readFileSync(resolved);
        return new Response(body, {
          headers: {
            "Content-Type": contentTypeForExt(ext),
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      },
    },
  },
});
