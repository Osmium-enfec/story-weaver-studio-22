/** Shared secret used by the external HD render Mac (`Authorization: Bearer …`). */

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function renderKeyConfigured(): boolean {
  return Boolean(process.env.RENDER_API_KEY?.trim());
}

/** Accepts `Authorization: Bearer <key>`, `x-render-key`, or `?key=` (for <video> tags). */
export function hasValidRenderKey(request: Request): boolean {
  const expected = process.env.RENDER_API_KEY?.trim();
  if (!expected) return false;
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const alt = request.headers.get("x-render-key")?.trim() ?? null;
  let query: string | null = null;
  try {
    query = new URL(request.url).searchParams.get("key");
  } catch {
    query = null;
  }
  return [bearer, alt, query].some((v) => v != null && timingSafeEqual(v, expected));
}

export function renderKeyError(): Response {
  const configured = renderKeyConfigured();
  return new Response(
    JSON.stringify({
      error: configured ? "Invalid render key" : "RENDER_API_KEY is not configured",
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}
