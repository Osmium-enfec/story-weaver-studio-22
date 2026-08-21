/**
 * Public feed for Div Studio in-app updates.
 * Drop latest.json + Div-Studio-*.dmg into:
 *   .data/div-studio-updates/
 */
import { createFileRoute } from "@tanstack/react-router";
import fs from "node:fs";
import path from "node:path";
import { hostDataRoot } from "@/lib/host-storage";

function updatesRoot() {
  return path.join(hostDataRoot(), "div-studio-updates");
}

function safeJoin(root: string, rel: string): string | null {
  const cleaned = rel.replace(/^\/+/, "").replace(/\.\./g, "");
  if (!cleaned || cleaned.includes("\0")) return null;
  const full = path.resolve(root, cleaned);
  if (!full.startsWith(path.resolve(root))) return null;
  return full;
}

export const Route = createFileRoute("/api/div-studio-updates/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const root = updatesRoot();
        fs.mkdirSync(root, { recursive: true });
        const splat =
          (params as { _splat?: string })._splat ??
          (params as { "*": string })["*"];
        const rel = String(splat || "latest.json");
        const file = safeJoin(root, rel || "latest.json");
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return new Response(JSON.stringify({ error: "not found", path: rel }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        const data = fs.readFileSync(file);
        const ext = path.extname(file).toLowerCase();
        const type =
          ext === ".json"
            ? "application/json; charset=utf-8"
            : ext === ".dmg"
              ? "application/x-apple-diskimage"
              : "application/octet-stream";
        return new Response(data, {
          status: 200,
          headers: {
            "Content-Type": type,
            "Content-Length": String(data.length),
            "Cache-Control": "no-cache",
            ...(ext === ".dmg"
              ? {
                  "Content-Disposition": `attachment; filename="${path.basename(file)}"`,
                }
              : {}),
          },
        });
      },
    },
  },
});
