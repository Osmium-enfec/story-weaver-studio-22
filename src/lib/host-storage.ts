import path from "node:path";

/** Root for all app data persisted on the machine running the dev server. */
export function hostDataRoot(): string {
  return path.join(process.cwd(), ".data");
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
