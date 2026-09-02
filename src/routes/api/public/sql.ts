import { createFileRoute } from "@tanstack/react-router";

/**
 * Shared-secret SQL bridge. The published (edge) app has no raw TCP sockets, so
 * it forwards queries here — to the self-hosted app, which talks to the DO
 * Postgres directly. That keeps both deployments on one database.
 *
 * Only enabled where SQL_PROXY_SECRET is configured AND a local Postgres
 * connection exists (i.e. the droplet). Never enabled on the edge build.
 */
export const Route = createFileRoute("/api/public/sql")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.SQL_PROXY_SECRET?.trim();
        const { ownPostgresUrl, isEdgeRuntime } = await import("@/lib/runtime-backends");
        if (!secret || isEdgeRuntime() || !ownPostgresUrl()) {
          return Response.json({ error: "SQL bridge not enabled" }, { status: 404 });
        }

        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (token.length !== secret.length || token !== secret) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        let body: { text?: unknown; params?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) {
          return Response.json({ error: "Missing SQL text" }, { status: 400 });
        }
        const params = Array.isArray(body.params) ? body.params : [];

        try {
          const { pgQuery } = await import("@/lib/pg");
          const result = await pgQuery(text, params);
          return Response.json({ rows: result.rows, rowCount: result.rowCount ?? 0 });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "SQL failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
