// Client-side cache to avoid re-spending credits on identical inputs.
// Keys are SHA-256 hashes; values live in localStorage.

const PLAN_PREFIX = "gen:plan:";
const STT_PREFIX = "gen:stt:";
const MAX_ENTRIES = 20;

async function sha256(input: ArrayBuffer | string): Promise<string> {
  const buf =
    typeof input === "string" ? new TextEncoder().encode(input).buffer : input;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashText(s: string): Promise<string> {
  return sha256(s);
}

export async function hashFile(f: File): Promise<string> {
  return sha256(await f.arrayBuffer());
}

function trim(prefix: string) {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix));
    if (keys.length <= MAX_ENTRIES) return;
    // drop oldest by stored `t` timestamp
    keys
      .map((k) => {
        try {
          const v = JSON.parse(localStorage.getItem(k) || "{}");
          return { k, t: v.t || 0 };
        } catch {
          return { k, t: 0 };
        }
      })
      .sort((a, b) => a.t - b.t)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach(({ k }) => localStorage.removeItem(k));
  } catch {}
}

export function getCachedPlan<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PLAN_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw).v as T;
  } catch {
    return null;
  }
}

export function setCachedPlan<T>(key: string, v: T) {
  try {
    localStorage.setItem(PLAN_PREFIX + key, JSON.stringify({ v, t: Date.now() }));
    trim(PLAN_PREFIX);
  } catch {}
}

export function getCachedStt<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(STT_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw).v as T;
  } catch {
    return null;
  }
}

export function setCachedStt<T>(key: string, v: T) {
  try {
    localStorage.setItem(STT_PREFIX + key, JSON.stringify({ v, t: Date.now() }));
    trim(STT_PREFIX);
  } catch {}
}
