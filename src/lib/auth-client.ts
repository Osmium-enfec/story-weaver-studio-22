const SESSION_KEY = "explainer_studio_session";

export type StoredSession = {
  token: string;
  user: { id: string; email: string };
};

export function getStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.token || !parsed?.user?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getStoredSessionToken(): string | null {
  return getStoredSession()?.token ?? null;
}

export function setStoredSession(session: StoredSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearStoredSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

const listeners = new Set<() => void>();

export function subscribeAuth(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notifyAuthChange(): void {
  listeners.forEach((cb) => cb());
}

export function persistAuthSession(session: StoredSession): void {
  setStoredSession(session);
  notifyAuthChange();
}

export function clearAuthSession(): void {
  clearStoredSession();
  notifyAuthChange();
}
