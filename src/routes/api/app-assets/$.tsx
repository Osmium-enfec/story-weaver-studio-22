import { createFileRoute } from "@tanstack/react-router";
import path from "node:path";
import { contentTypeForExt } from "@/lib/asset-mime";
import { readAsset } from "@/lib/object-storage";

/**
 * Course-scoped built-in clip: /api/app-assets/course/<courseId>/<file>.mp3
 * Resolves the course's current voice at request time so changing the course
 * voice updates every existing scene without regenerating anything.
 * Course-less legacy clip names resolve to the default voice.
 */
async function resolveRelPath(rel: string): Promise<string | null> {
  const { resolveAppAssetRelPath } = await import("@/lib/default-voice-assets.server");
  return resolveAppAssetRelPath(rel);
}

export const Route = createFileRoute("/api/app-assets/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const raw = params._splat ?? "";
        if (!raw || raw.includes("..")) {
          return new Response("Not found", { status: 404 });
        }

        let rel: string | null;
        try {
          rel = await resolveRelPath(raw);
        } catch (err) {
          return new Response(
            `Default narration unavailable: ${err instanceof Error ? err.message : "error"}`,
            { status: 503 },
          );
        }
        if (!rel) return new Response("Not found", { status: 404 });

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
