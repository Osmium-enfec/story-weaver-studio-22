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

/** Default SQL proxy (the droplet app, which has raw TCP access to DO Postgres). */
const DEFAULT_SQL_PROXY_URL = "https://studio.enfeca.cloud/api/public/sql";

/**
 * Direct (TCP) DO Postgres connection string. Only the self-hosted droplet sets
 * DATABASE_URL; everywhere else the database is reached through the SQL bridge,
 * which avoids IP allow-listing and works in edge runtimes.
 */
export function ownPostgresUrl(): string {
  return process.env.DATABASE_URL?.trim() || "";
}

/** Postgres connection string: own DO database first, else the cloud database. */
export function postgresUrl(): string {
  // Edge runtimes have no raw TCP sockets — those go through the SQL bridge.
  if (isEdgeRuntime()) return "";
  const own = ownPostgresUrl();
  if (own) return own;
  if (useSqlProxy()) return "";
  // Hosted runtime → SQLite/disk is unavailable; use the cloud Postgres.
  if (isHostedBuild()) return process.env.SUPABASE_DB_URL?.trim() || "";
  return "";
}

/** True when the resolved Postgres URL is the managed cloud DB (private `app` schema). */
export function usingCloudPostgres(): boolean {
  return !ownPostgresUrl() && Boolean(postgresUrl());
}

/**
 * Everything that is not the self-hosted droplet forwards SQL to the droplet
 * app over HTTPS, so preview, published and self-hosted all share one database.
 */
export function sqlProxyUrl(): string {
  if (ownPostgresUrl()) return "";
  if (!process.env.SQL_PROXY_SECRET?.trim()) return "";
  return process.env.SQL_PROXY_URL?.trim() || DEFAULT_SQL_PROXY_URL;
}

export function useSqlProxy(): boolean {
  return Boolean(sqlProxyUrl());
}


/**
 * Hosted build with no Postgres connection string and no SQL proxy: talk to the
 * cloud database over HTTP (service-role RPC) instead of raw TCP.
 */
export function useCloudRest(): boolean {
  if (postgresUrl()) return false;
  if (useSqlProxy()) return false;
  if (!isHostedBuild()) return false;
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

export function usePostgres(): boolean {
  return Boolean(postgresUrl()) || useSqlProxy() || useCloudRest();
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

/**
 * Cloud storage credentials are present. Used as a read fallback for objects
 * uploaded before the Spaces migration (they still live in the cloud bucket).
 */
export function hasCloudStorage(): boolean {
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
  const configured =
    process.env.ENFEC_SCRATCH_ROOT?.trim() ||
    process.env.HOST_SCRATCH_ROOT?.trim();
  if (configured) return configured;

  // Hosted deployments mount the application bundle read-only. Media jobs
  // must materialize uploads under the runtime's writable temporary volume.
  if (isHostedBuild()) return "/tmp/divstudio";

  return `${process.cwd()}/.data/scratch`;
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
