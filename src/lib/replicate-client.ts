export const REPLICATE_API = "https://api.replicate.com/v1";

export function requireReplicateKey(): string {
  const key =
    process.env.REPLICATE_API_KEY ?? process.env.LOVABLE_CONNECTOR_REPLICATE_API_KEY;
  if (!key) throw new Error("REPLICATE_API_KEY not configured");
  return key;
}

export async function replicateFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${requireReplicateKey()}`);
  if (!(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${REPLICATE_API}${path}`, { ...init, headers });
}
