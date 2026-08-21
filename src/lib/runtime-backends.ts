/**
 * Dual-backend switches for DigitalOcean deploy.
 *
 * Local LAN / `vite dev`: leave these unset → SQLite + disk under `.data/` (unchanged).
 * Droplet / Docker: set DATABASE_URL + Spaces vars → Postgres + object storage.
 */

export function usePostgres(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
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
