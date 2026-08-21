import { createFileRoute } from "@tanstack/react-router";
import { describeBackends } from "@/lib/runtime-backends";
import { jsonResponse } from "@/lib/api-auth";

/**
 * Reports whether the Postgres schema is actually usable. Status stays 200 even
 * on a database error so the Docker healthcheck / restart behaviour is
 * unchanged — the detail is there to diagnose without reading container logs.
 */
async function probeDb(): Promise<{ schema: "ready" | "error"; error?: string }> {
  try {
    const { pgQuery } = await import("@/lib/pg");
    await pgQuery(`SELECT 1 FROM users LIMIT 1`);
    return { schema: "ready" };
  } catch (error) {
    return {
      schema: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const backends = describeBackends();
        return jsonResponse({
          ok: true,
          backends,
          db: backends.db === "postgres" ? await probeDb() : { schema: "ready" },
          time: new Date().toISOString(),
        });
      },
    },
  },
});
