import { localValidateSession, type AuthUser } from "@/lib/local-auth-db";
import { isAdminUser } from "@/lib/admin";

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export async function requireApiUser(request: Request): Promise<AuthUser> {
  const token = bearerToken(request);
  if (!token) {
    throw jsonError("Unauthorized", 401);
  }
  const user = await localValidateSession(token);
  if (!user) {
    throw jsonError("Unauthorized", 401);
  }
  return user;
}

export async function requireApiAdmin(request: Request): Promise<AuthUser> {
  const user = await requireApiUser(request);
  if (!isAdminUser(user)) {
    throw jsonError("Admin only", 403);
  }
  return user;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
