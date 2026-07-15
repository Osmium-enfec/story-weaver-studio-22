import { createMiddleware } from "@tanstack/react-start";
import { getStoredSessionToken } from "@/lib/auth-client";

export const attachAuth = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const token = getStoredSessionToken();
  return next({
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
});
