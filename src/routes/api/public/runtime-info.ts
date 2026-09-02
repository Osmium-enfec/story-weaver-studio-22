import { createFileRoute } from "@tanstack/react-router";
import { describeBackends, isEdgeRuntime, usePostgres, useSqlProxy } from "@/lib/runtime-backends";

/**
 * Non-sensitive deploy diagnostic: which storage backend the running server uses
 * and whether the cloud database connection string is present. No secrets leak —
 * only booleans and backend names.
 */
export const Route = createFileRoute("/api/public/runtime-info")({
  server: {
    handlers: {
      GET: async () => {
        let dbOk = false;
        let dbError: string | null = null;
        if (usePostgres()) {
          try {
            const { pgQuery } = await import("@/lib/pg");
            await pgQuery("SELECT 1");
            dbOk = true;
          } catch (err) {
            dbError = err instanceof Error ? err.message : "unknown error";
          }
        }
        return Response.json({
          edge: isEdgeRuntime(),
          nodeEnv: process.env.NODE_ENV ?? null,
          hasDatabaseUrl: Boolean(process.env.DATABASE_URL?.trim()),
          hasCloudDbUrl: Boolean(process.env.SUPABASE_DB_URL?.trim()),
          hasServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
          backends: describeBackends(),
          sqlBridge: useSqlProxy(),
          dbOk,
          dbError,
        });
      },
    },
  },
});
