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

/**
 * True on the hosted/published build. Published hosting has no writable disk and
 * no native SQLite, so the cloud Postgres must be used there.
 */
export function isHostedBuild(): boolean {
  if ((process.env.ENFEC_FORCE_SQLITE ?? "").trim() === "1") return false;
  if (isEdgeRuntime()) return true;
  // Lovable preview sandbox: disk/SQLite is ephemeral, so mirror the published
  // app and use the cloud database (same accounts, courses and episodes).
  if (process.env.LOVABLE_SANDBOX?.trim() === "1" && !process.env.ENFEC_SELF_HOSTED?.trim()) {
    return true;
  }
  return (
    process.env.NODE_ENV === "production" &&
    !process.env.ENFEC_SELF_HOSTED?.trim()
  );
}

/** Postgres connection string: explicit DATABASE_URL, else the cloud database. */
export function postgresUrl(): string {
  const explicit = process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  // Hosted runtime → SQLite/disk is unavailable; use the cloud Postgres.
  if (isHostedBuild()) return process.env.SUPABASE_DB_URL?.trim() || "";
  return "";
}



/**
 * Hosted build with no Postgres connection string: talk to the cloud database
 * over HTTP (service-role RPC) instead of raw TCP, which edge runtimes lack.
 */
export function useCloudRest(): boolean {
  if (postgresUrl()) return false;
  if (!isHostedBuild()) return false;
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

export function usePostgres(): boolean {
  return Boolean(postgresUrl()) || useCloudRest();
}

/**
 * Hosted build with no Spaces credentials: store/serve media in the cloud
 * storage bucket, since the edge runtime has no writable disk.
 */
export function useCloudStorage(): boolean {
  if (useSpaces()) return false;
  if (!isHostedBuild()) return false;
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
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
  storage: "spaces" | "cloud" | "disk";
} {
  return {
    db: usePostgres() ? "postgres" : "sqlite",
    storage: useSpaces() ? "spaces" : useCloudStorage() ? "cloud" : "disk",
  };
}
