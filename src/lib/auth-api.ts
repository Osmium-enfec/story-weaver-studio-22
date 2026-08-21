import { getStoredSessionToken } from "@/lib/auth-client";
import type { StoredSession } from "@/lib/auth-client";

async function authPost(
  body: Record<string, unknown>,
): Promise<{ user: StoredSession["user"]; token: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getStoredSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch("/api/auth", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { error?: string; user?: StoredSession["user"]; token?: string };
  if (!res.ok) throw new Error(data.error ?? "Auth request failed");
  if (!data.user || !data.token) throw new Error("Invalid auth response");
  return { user: data.user, token: data.token };
}

export async function apiLogin(email: string, password: string) {
  return authPost({ action: "login", email, password });
}

export async function apiRegister(email: string, password: string) {
  return authPost({ action: "register", email, password });
}

export async function apiLogout(): Promise<void> {
  const token = getStoredSessionToken();
  if (!token) return;
  await fetch("/api/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: "logout" }),
  }).catch(() => {});
}
