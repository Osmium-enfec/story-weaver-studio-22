import dns from "node:dns/promises";
import { defaultStudioOrigin } from "@/lib/work-sync";

function trimOrigin(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function extraOriginsFromEnv(): string[] {
  return (process.env.DIV_STUDIO_EXTRA_ORIGINS || "")
    .split(/[\s,]+/)
    .map((s) => trimOrigin(s))
    .filter((s) => /^https?:\/\//i.test(s));
}

export function describeStudioFetchError(err: unknown, origin: string): string {
  const e = err as Error & { cause?: { code?: string } };
  const code = e.cause?.code || "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Could not find ${origin} on this Wi‑Fi. Stay on the same network as the main Mac, or set Settings → Studio host to http://<main-mac-ip>:8080.`;
  }
  if (code === "ECONNREFUSED") {
    return `Nothing is listening at ${origin}. The main Studio Mac must be on, with port 8080 available.`;
  }
  if (
    code === "ETIMEDOUT" ||
    e.name === "TimeoutError" ||
    /aborted|timeout/i.test(e.message || "")
  ) {
    return `Timed out reaching ${origin}. Check Wi‑Fi / VPN, then retry Get latest data.`;
  }
  if (/fetch failed/i.test(e.message || "")) {
    return (
      `Could not reach the main Studio Mac at ${origin}` +
      (code ? ` (${code})` : "") +
      `. Use the same Wi‑Fi, or set Settings → Studio host to the main Mac’s current IP on port 8080.`
    );
  }
  return e.message || "Could not reach the main Studio Mac.";
}

export async function studioOriginsToTry(preferred?: string): Promise<string[]> {
  const raw = [
    preferred,
    defaultStudioOrigin(),
    "http://D-MacBook-Pro.local:8080",
    "http://d-macbook-pro.local:8080",
    ...extraOriginsFromEnv(),
  ]
    .filter((s): s is string => Boolean(s && s.trim()))
    .map(trimOrigin);

  const bases = [...new Set(raw)];
  const resolved: string[] = [];
  for (const origin of bases) {
    try {
      const u = new URL(origin);
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) {
        const { address } = await dns.lookup(u.hostname, { family: 4 });
        const port = u.port || (u.protocol === "https:" ? "443" : "80");
        resolved.push(`${u.protocol}//${address}:${port}`);
      }
    } catch {
      /* mDNS often fails from Node on guest Macs */
    }
  }
  return [...new Set([...bases, ...resolved])];
}

export async function fetchStudio(
  pathAndQuery: string,
  init?: RequestInit & { origin?: string },
): Promise<{ res: Response; origin: string }> {
  const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  const origins = await studioOriginsToTry(init?.origin);
  const errors: string[] = [];
  for (const origin of origins) {
    try {
      const res = await fetch(`${origin}${path}`, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(120000),
      });
      if (res.status === 404) {
        errors.push(`${origin} → 404`);
        continue;
      }
      return { res, origin };
    } catch (e) {
      errors.push(describeStudioFetchError(e, origin));
    }
  }
  throw new Error(
    errors[errors.length - 1] ||
      `Could not reach the main Studio Mac (${origins.join(", ")}).`,
  );
}
