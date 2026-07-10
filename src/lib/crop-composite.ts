// Crop a normalized bbox from a composite image and return a PNG data URL.
// If a `maskUrl` is provided (white-on-black mask covering the WHOLE composite,
// same dimensions), it is used as an alpha channel so ONLY the element pixels
// remain (no square background bleed). Without a mask, falls back to
// white-background removal on the cropped rectangle.
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

function computeCropRect(bbox: Bbox, pad: number, IW: number, IH: number) {
  const bx = Math.max(0, bbox.x - bbox.w * pad);
  const by = Math.max(0, bbox.y - bbox.h * pad);
  const bw = Math.min(1 - bx, bbox.w * (1 + pad * 2));
  const bh = Math.min(1 - by, bbox.h * (1 + pad * 2));
  return {
    sx: Math.round(bx * IW),
    sy: Math.round(by * IH),
    sw: Math.max(1, Math.round(bw * IW)),
    sh: Math.max(1, Math.round(bh * IH)),
  };
}

async function processWhiteBg(compositeUrl: string, bbox: Bbox, pad: number): Promise<string> {
  const img = await loadCorsImage(compositeUrl);
  const IW = img.naturalWidth || 1;
  const IH = img.naturalHeight || 1;
  const { sx, sy, sw, sh } = computeCropRect(bbox, pad, IW, IH);

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return compositeUrl;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

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

async function processWithMask(
  compositeUrl: string,
  maskUrl: string,
  bbox: Bbox,
  pad: number,
): Promise<string> {
  const [img, mask] = await Promise.all([loadCorsImage(compositeUrl), loadCorsImage(maskUrl)]);
  const IW = img.naturalWidth || 1;
  const IH = img.naturalHeight || 1;
  const { sx, sy, sw, sh } = computeCropRect(bbox, pad, IW, IH);

  // Render composite crop.
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return compositeUrl;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  // Render mask scaled to the composite dimensions, then read the mask region.
  const mCanvas = document.createElement("canvas");
  mCanvas.width = sw;
  mCanvas.height = sh;
  const mCtx = mCanvas.getContext("2d", { willReadFrequently: true });
  if (!mCtx) return canvas.toDataURL("image/png");
  // Mask is same aspect as composite; scale-draw the corresponding crop region.
  mCtx.drawImage(mask, sx * (mask.naturalWidth / IW), sy * (mask.naturalHeight / IH),
    sw * (mask.naturalWidth / IW), sh * (mask.naturalHeight / IH),
    0, 0, sw, sh);

  let data: ImageData;
  let mData: ImageData;
  try {
    data = ctx.getImageData(0, 0, sw, sh);
    mData = mCtx.getImageData(0, 0, sw, sh);
  } catch {
    return canvas.toDataURL("image/png");
  }

  const px = data.data;
  const mp = mData.data;
  // Mask: white pixels → keep, black → transparent. Feather threshold.
  for (let i = 0; i < px.length; i += 4) {
    // Use luminance of mask pixel.
    const lum = (mp[i] + mp[i + 1] + mp[i + 2]) / 3;
    // Soft ramp: <64 = fully transparent, >192 = fully opaque.
    let a = 0;
    if (lum >= 192) a = 1;
    else if (lum <= 64) a = 0;
    else a = (lum - 64) / 128;
    px[i + 3] = Math.round(px[i + 3] * a);
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Rectangle crop only — no background removal, no mask. Used for text runs
 * where OCR gave us a tight bbox and any alpha processing would eat glyphs.
 */
async function processRect(compositeUrl: string, bbox: Bbox, pad: number): Promise<string> {
  const img = await loadCorsImage(compositeUrl);
  const IW = img.naturalWidth || 1;
  const IH = img.naturalHeight || 1;
  const { sx, sy, sw, sh } = computeCropRect(bbox, pad, IW, IH);
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return compositeUrl;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/png");
}

/**
 * Crop `bbox` (normalized 0..1) from `compositeUrl`.
 * mode:
 *   "mask"  — SAM mask as alpha (needs maskUrl)
 *   "white" — remove white background from rectangle (default when no mask)
 *   "rect"  — plain rectangle crop, no alpha work (best for text)
 */
export function cropAndClear(
  compositeUrl: string,
  bbox: Bbox,
  padFrac = 0.06,
  maskUrl?: string,
  mode?: "mask" | "white" | "rect",
): Promise<string> {
  const resolved: "mask" | "white" | "rect" = mode ?? (maskUrl ? "mask" : "white");
  const key = `${compositeUrl.slice(0, 64)}|${resolved}|${maskUrl ? maskUrl.slice(0, 48) : ""}|${bbox.x.toFixed(3)},${bbox.y.toFixed(3)},${bbox.w.toFixed(3)},${bbox.h.toFixed(3)}|${padFrac}`;
  let p = cache.get(key);
  if (!p) {
    p = (resolved === "rect"
      ? processRect(compositeUrl, bbox, padFrac)
      : resolved === "mask" && maskUrl
        ? processWithMask(compositeUrl, maskUrl, bbox, padFrac)
        : processWhiteBg(compositeUrl, bbox, padFrac)
    ).catch(() => compositeUrl);
    cache.set(key, p);
  }
  return p;
}
