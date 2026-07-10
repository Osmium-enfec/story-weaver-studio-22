// Crop a normalized bbox from a composite image and return a PNG data URL
// with the ~white paper background removed (soft alpha ramp).
//
// bbox: { x, y, w, h } in 0..1 coordinates of the source image.

interface Bbox { x: number; y: number; w: number; h: number }

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

async function processCrop(compositeUrl: string, bbox: Bbox, pad: number): Promise<string> {
  const img = await loadCorsImage(compositeUrl);
  const IW = img.naturalWidth || 1;
  const IH = img.naturalHeight || 1;

  // Expand bbox by pad fraction and clamp to image.
  const bx = Math.max(0, bbox.x - bbox.w * pad);
  const by = Math.max(0, bbox.y - bbox.h * pad);
  const bw = Math.min(1 - bx, bbox.w * (1 + pad * 2));
  const bh = Math.min(1 - by, bbox.h * (1 + pad * 2));

  const sx = Math.round(bx * IW);
  const sy = Math.round(by * IH);
  const sw = Math.max(1, Math.round(bw * IW));
  const sh = Math.max(1, Math.round(bh * IH));

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return compositeUrl;

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  // White-background removal (same feathered threshold as remove-white-bg.ts).
  let data: ImageData;
  try { data = ctx.getImageData(0, 0, sw, sh); }
  catch { return canvas.toDataURL("image/png"); }
  const px = data.data;
  const WHITE = 238;
  const FEATHER = 22;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const minC = Math.min(r, g, b);
    if (minC >= WHITE) {
      const t = Math.min(1, (minC - WHITE) / FEATHER);
      px[i + 3] = Math.round(px[i + 3] * (1 - t));
    } else if (minC >= WHITE - FEATHER) {
      const t = (minC - (WHITE - FEATHER)) / FEATHER;
      px[i + 3] = Math.round(px[i + 3] * (1 - t * 0.85));
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Crop `bbox` (normalized 0..1) from `compositeUrl`, remove white background,
 * and return a transparent PNG data URL. Cached by (compositeUrl + bbox).
 */
export function cropAndClear(
  compositeUrl: string,
  bbox: Bbox,
  padFrac = 0.06,
): Promise<string> {
  const key = `${compositeUrl.slice(0, 64)}|${bbox.x.toFixed(3)},${bbox.y.toFixed(3)},${bbox.w.toFixed(3)},${bbox.h.toFixed(3)}|${padFrac}`;
  let p = cache.get(key);
  if (!p) {
    p = processCrop(compositeUrl, bbox, padFrac).catch(() => compositeUrl);
    cache.set(key, p);
  }
  return p;
}
