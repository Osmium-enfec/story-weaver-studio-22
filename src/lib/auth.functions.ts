import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  localLoginUser,
  localLogoutSession,
  localRegisterUser,
  localValidateSession,
} from "@/lib/local-auth-db";
import { requireAuth } from "@/integrations/auth/auth-middleware";

const Credentials = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(200),
});

export const register = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => Credentials.parse(d))
  .handler(async ({ data }) => {
    localRegisterUser(data.email, data.password);
    return localLoginUser(data.email, data.password);
  });

export const login = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => Credentials.parse(d))
  .handler(async ({ data }) => localLoginUser(data.email, data.password));

export const logout = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    localLogoutSession(context.token);
    return { ok: true };
  });

export const me = createServerFn({ method: "POST" }).handler(async () => {
  const request = getRequest();
  const authHeader = request?.headers?.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const user = localValidateSession(token);
  return { user };
});
