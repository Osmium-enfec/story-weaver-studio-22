import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  localLoginUser,
  localLogoutSession,
  localRegisterUser,
  localValidateSession,
} from "@/lib/local-auth-db";
import { bearerToken, jsonError, jsonResponse } from "@/lib/api-auth";
import { withAdminFlag } from "@/lib/admin";
import { ensureBootstrapAdmins } from "@/lib/ensure-admin";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("register"),
    email: z.string().email(),
    password: z.string().min(6).max(200),
  }),
  z.object({
    action: z.literal("login"),
    email: z.string().email(),
    password: z.string().min(6).max(200),
  }),
  z.object({ action: z.literal("logout") }),
  z.object({ action: z.literal("me") }),
]);

export const Route = createFileRoute("/api/auth")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureBootstrapAdmins();

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError("Invalid JSON", 400);
        }

        const parsed = Body.safeParse(body);
        if (!parsed.success) {
          return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
        }

        const data = parsed.data;
        if (data.action === "register") {
          try {
            await localRegisterUser(data.email, data.password);
            const session = await localLoginUser(data.email, data.password);
            return jsonResponse({
              ...session,
              user: withAdminFlag(session.user),
            });
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Register failed", 400);
          }
        }

        if (data.action === "login") {
          try {
            const session = await localLoginUser(data.email, data.password);
            return jsonResponse({
              ...session,
              user: withAdminFlag(session.user),
            });
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Login failed", 401);
          }
        }

        if (data.action === "logout") {
          const token = bearerToken(request);
          if (token) await localLogoutSession(token);
          return jsonResponse({ ok: true });
        }

        const token = bearerToken(request);
        if (!token) return jsonError("Unauthorized", 401);
        const user = await localValidateSession(token);
        if (!user) return jsonError("Unauthorized", 401);
        return jsonResponse({ user: withAdminFlag(user), token });
      },
    },
  },
});
