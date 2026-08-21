import type { AuthUser } from "@/lib/local-auth-db";

/** Hardcoded bootstrap admin — also overridable via ADMIN_EMAILS (comma-separated). */
export const DEFAULT_ADMIN_EMAILS = ["divyanshu.singh@enfec.com"];

export function adminEmails(): string[] {
  // Client bundles may not define `process`; never touch it bare.
  const envEmails =
    typeof process !== "undefined" && process.env
      ? (process.env.ADMIN_EMAILS ?? "")
      : "";
  const fromEnv = envEmails
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const set = new Set([...DEFAULT_ADMIN_EMAILS.map((e) => e.toLowerCase()), ...fromEnv]);
  return Array.from(set);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}

export function isAdminUser(user: Pick<AuthUser, "email">): boolean {
  return isAdminEmail(user.email);
}

export function withAdminFlag<T extends { email: string }>(
  user: T,
): T & { isAdmin: boolean } {
  return { ...user, isAdmin: isAdminEmail(user.email) };
}
