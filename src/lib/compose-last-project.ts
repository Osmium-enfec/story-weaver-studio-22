const LAST_PROJECT_KEY = "compose:lastProjectId";

export function rememberLastProject(id: string) {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    /* ignore quota / private mode */
  }
}

export function getLastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function clearLastProject(id?: string) {
  try {
    if (!id || localStorage.getItem(LAST_PROJECT_KEY) === id) {
      localStorage.removeItem(LAST_PROJECT_KEY);
    }
  } catch {
    /* ignore */
  }
}
