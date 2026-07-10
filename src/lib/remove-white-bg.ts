// Convert a white-background element image into a transparent PNG data URL.
// In-memory cached; safe to call repeatedly with the same URL.

const cache = new Map<string, Promise<string>>();

function loadCorsImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function process(url: string): Promise<string> {
  const img = await loadCorsImage(url);
  const w = img.naturalWidth || 512;
  const h = img.naturalHeight || 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return url;
  ctx.drawImage(img, 0, 0);
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, w, h);
  } catch {
    // CORS taint: fall back to original URL.
    return url;
  }
  const px = data.data;
  // Threshold: pixels near white become transparent; soft ramp near boundary
  // so anti-aliased edges of hand-drawn outlines stay smooth.
  const WHITE = 238; // channels above this considered "white-ish"
  const FEATHER = 20;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const minC = Math.min(r, g, b);
    if (minC >= WHITE) {
      // Fully white → fully transparent.
      const t = Math.min(1, (minC - WHITE) / FEATHER);
      px[i + 3] = Math.round(px[i + 3] * (1 - t));
    } else if (minC >= WHITE - FEATHER) {
      // Near-white → partial transparency ramp.
      const t = (minC - (WHITE - FEATHER)) / FEATHER;
      px[i + 3] = Math.round(px[i + 3] * (1 - t * 0.85));
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

export function getTransparentUrl(url: string): Promise<string> {
  if (!url) return Promise.resolve(url);
  let p = cache.get(url);
  if (!p) {
    p = process(url).catch(() => url);
    cache.set(url, p);
  }
  return p;
}

export function getTransparentUrlSync(url: string): string | undefined {
  // Non-blocking peek; used by rasterizer after preloading transparent versions.
  const p = cache.get(url);
  if (!p) return undefined;
  // We can't await; caller must have awaited getTransparentUrl already.
  // Return undefined; caller falls back to original.
  return undefined;
}

export async function preloadTransparent(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    urls.map(async (u) => {
      const t = await getTransparentUrl(u);
      out.set(u, t);
    }),
  );
  return out;
}
