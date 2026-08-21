/**
 * Dual-backend switches for DigitalOcean deploy.
 *
 * Local LAN / `vite dev`: leave these unset → SQLite + disk under `.data/` (unchanged).
 * Droplet / Docker: set DATABASE_URL + Spaces vars → Postgres + object storage.
 */

/**
 * True when running in a serverless edge worker (published app): no writable
 * filesystem and no native modules, so SQLite/disk backends cannot be used.
 */
export function isEdgeRuntime(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.userAgent === "string" &&
      navigator.userAgent.includes("Cloudflare-Workers")
    );
  } catch {
    return false;
  }
}

/** Postgres connection string: explicit DATABASE_URL, else the cloud database. */
export function postgresUrl(): string {
  const explicit = process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  // Published edge runtime has no SQLite — fall back to the cloud Postgres.
  if (isEdgeRuntime()) return process.env.SUPABASE_DB_URL?.trim() || "";
  return "";
}

export function usePostgres(): boolean {
  return Boolean(postgresUrl());
}

export function useSpaces(): boolean {
  return Boolean(
    process.env.SPACES_BUCKET?.trim() &&
      process.env.SPACES_KEY?.trim() &&
      process.env.SPACES_SECRET?.trim() &&
      process.env.SPACES_ENDPOINT?.trim(),
  );
}

export function scratchRoot(): string {
  return (
    process.env.ENFEC_SCRATCH_ROOT?.trim() ||
    process.env.HOST_SCRATCH_ROOT?.trim() ||
    `${process.cwd()}/.data/scratch`
  );
}

export function describeBackends(): {
  db: "postgres" | "sqlite";
  storage: "spaces" | "disk";
} {
  return {
    db: usePostgres() ? "postgres" : "sqlite",
    storage: useSpaces() ? "spaces" : "disk",
  };
}
