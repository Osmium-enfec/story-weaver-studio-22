import { DEFAULT_ADMIN_EMAILS } from "@/lib/admin";
import { usePostgres } from "@/lib/runtime-backends";
import { localEnsureUser } from "@/lib/local-auth-db";

let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;

/**
 * Ensure bootstrap admin accounts exist.
 * Safe to call on every request — runs once per process.
 * No-op path for local SQLite when password/env is whatever was already used.
 */
export async function ensureBootstrapAdmins(): Promise<void> {
  if (bootstrapped) return;
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    if (usePostgres()) {
      const { ensurePgSchema } = await import("@/lib/pg");
      await ensurePgSchema();
    }
    const password =
      process.env.ADMIN_BOOTSTRAP_PASSWORD?.trim() || "EnfecAdmin2026!";
    let ok = 0;
    for (const email of DEFAULT_ADMIN_EMAILS) {
      try {
        await localEnsureUser(email, password);
        ok += 1;
      } catch (e) {
        console.warn("[admin] bootstrap failed for", email, e);
      }
    }
    // Only lock out retries if at least one admin landed (or there were none to create).
    if (ok > 0 || DEFAULT_ADMIN_EMAILS.length === 0) {
      bootstrapped = true;
    } else {
      bootstrapPromise = null;
    }
  })();
  return bootstrapPromise;
}
