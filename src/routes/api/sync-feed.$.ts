/**
 * Public LAN feed for work sync — serves the assignments snapshot that admin
 * publishes via Admin → Assignments → Push assignments.
 *
 * Kept on its own path (not /api/sync/*) so it does not nest under the
 * /api/sync action route, which would shadow that route's POST handler.
 */
import { createFileRoute } from "@tanstack/react-router";
import fs from "node:fs";
import path from "node:path";
import { isAdminEmail } from "@/lib/admin";
import { hostDataRoot } from "@/lib/host-storage";
import { buildAssignmentsSnapshot } from "@/lib/work-sync";

function syncRoot() {
  return path.join(hostDataRoot(), "sync");
}

export const Route = createFileRoute("/api/sync-feed/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const root = syncRoot();
        fs.mkdirSync(root, { recursive: true });
        const splat =
          (params as { _splat?: string })._splat ??
          (params as { "*": string })["*"];
        const rel = String(splat || "assignments-latest.json");

        if (rel === "python-for-ai-latest.json") {
          const url = new URL(request.url);
          const email = (url.searchParams.get("email") || "").trim().toLowerCase();
          const userId = (url.searchParams.get("userId") || "").trim();
          if (!email) {
            return new Response(JSON.stringify({ error: "email is required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          try {
            // Admin must receive every current assignment (live DB), not a
            // scoped "parts assigned to me" feed — otherwise Get latest is 0
            // and the desktop app keeps stale assignees.
            const snapshot = await buildAssignmentsSnapshot(
              "live-main-db",
              isAdminEmail(email) ? undefined : { userId, email },
            );
            // Never 404 here: the desktop app treats 404 as "try D-MacBook-Pro.local"
            // and then shows net::ERR_NAME_NOT_RESOLVED even when the IP worked.
            const payload = {
              ...snapshot,
              assets: [],
              missingAssets: [],
            };
            return new Response(JSON.stringify(payload), {
              status: 200,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
              },
            });
          } catch (error: unknown) {
            return new Response(
              JSON.stringify({
                error: error instanceof Error ? error.message : "Could not build latest data",
              }),
              {
                status: 500,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }

        // Only the published snapshot is public — never inbox packages.
        if (rel !== "assignments-latest.json") {
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        const file = path.join(root, "assignments-latest.json");
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return new Response(
            JSON.stringify({
              error:
                "No assignments pushed yet. On the LAN Studio: Admin → Assignments → Push assignments.",
            }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }

        const data = fs.readFileSync(file);
        return new Response(data, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": String(data.length),
            "Cache-Control": "no-cache",
          },
        });
      },
    },
  },
});
