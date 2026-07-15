import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { localValidateSession } from "@/lib/local-auth-db";

export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const request = getRequest();
  if (!request?.headers) {
    throw new Error("Unauthorized: No request headers available");
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Unauthorized: Sign in required");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const user = localValidateSession(token);
  if (!user) {
    throw new Error("Unauthorized: Session expired or invalid");
  }

  return next({
    context: {
      userId: user.id,
      email: user.email,
      token,
    },
  });
});
