import { createFileRoute } from "@tanstack/react-router";
import path from "node:path";
import { contentTypeForExt } from "@/lib/asset-mime";
import { readAsset, signedAssetUrl } from "@/lib/object-storage";
import { hasValidRenderKey, renderKeyError } from "@/lib/render-key";

/**
 * Render-key protected asset download for the external HD render Mac.
 * `/api/public/assets/project/<rel>` and `/api/public/assets/app/<rel>`.
 *
 * Large media (screen recordings, master audio) is redirected to a short-lived
 * signed object-storage URL so bytes never stream through the edge worker.
 */
function parse(splat: string): { kind: "project" | "app"; rel: string } | null {
  const slash = splat.indexOf("/");
  const kindRaw = slash === -1 ? "" : splat.slice(0, slash);
  const rel = slash === -1 ? "" : splat.slice(slash + 1);
  if (!rel || rel.includes("..") || (kindRaw !== "project" && kindRaw !== "app")) return null;
  return { kind: kindRaw, rel };
}

async function handle(request: Request, splat: string, method: "GET" | "HEAD") {
  if (!hasValidRenderKey(request)) return renderKeyError();

  const parsed = parse(splat);
  if (!parsed) return new Response("Not found", { status: 404 });

  const contentType = contentTypeForExt(path.extname(parsed.rel).slice(1));

  // Prefer a direct signed URL from object storage (no worker proxying).
  try {
    const signed = await signedAssetUrl(parsed.kind, parsed.rel);
    if (signed) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: signed,
          "Cache-Control": "no-store",
          "x-asset-content-type": contentType,
        },
      });
    }
  } catch {
    /* fall through to streaming */
  }

  const result = await readAsset({
    kind: parsed.kind,
    relPath: parsed.rel,
    contentType,
    rangeHeader: request.headers.get("range"),
  });
  if (!result) return new Response("Not found", { status: 404 });

  return new Response(method === "HEAD" ? null : result.body, {
    status: result.status,
    headers: result.headers,
  });
}

export const Route = createFileRoute("/api/public/assets/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => handle(request, params._splat ?? "", "GET"),
      HEAD: async ({ params, request }) => handle(request, params._splat ?? "", "HEAD"),
    },
  },
});
