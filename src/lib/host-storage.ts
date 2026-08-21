import path from "node:path";

/** Root for all app data persisted on the machine running the dev server. */
export function hostDataRoot(): string {
  // When running multiple dev servers (multiple users/systems) that should share
  // projects/assignments/assets, point them at the same directory via env var.
  return (
    process.env.ENFEC_DATA_ROOT ??
    process.env.HOST_DATA_ROOT ??
    path.join(process.cwd(), ".data")
  );
}

export function hostProjectsDbPath(): string {
  return process.env.LOCAL_PROJECTS_DB ?? path.join(hostDataRoot(), "projects.db");
}

export function hostAppDbPath(): string {
  return process.env.LOCAL_APP_DB ?? path.join(hostDataRoot(), "app.db");
}

export function hostProjectAssetsRoot(): string {
  return path.join(hostDataRoot(), "project-assets");
}

export function hostAppAssetsRoot(): string {
  return path.join(hostDataRoot(), "app-assets");
}
