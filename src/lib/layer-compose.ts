// Client-side helpers: apply mask as alpha, compute bbox, download.

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export interface LayerBitmap {
  pngUrl: string; // transparent PNG data URL
  bbox: { x: number; y: number; w: number; h: number }; // in image pixels
  area: number;
}

/**
 * Apply a white-on-black mask as alpha channel to the source image.
 * Returns a transparent PNG (cropped to the mask's bbox for smaller files).
 */
export async function extractLayer(sourceUrl: string, maskUrl: string): Promise<LayerBitmap> {
  const [img, mask] = await Promise.all([loadImg(sourceUrl), loadImg(maskUrl)]);
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  // Render source
  const sc = document.createElement("canvas");
  sc.width = W;
  sc.height = H;
  const sctx = sc.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0, W, H);
  const sData = sctx.getImageData(0, 0, W, H);

  // Render mask scaled to source size
  const mc = document.createElement("canvas");
  mc.width = W;
  mc.height = H;
  const mctx = mc.getContext("2d", { willReadFrequently: true })!;
  mctx.drawImage(mask, 0, 0, W, H);
  const mData = mctx.getImageData(0, 0, W, H);

  // Apply alpha + compute bbox
  const px = sData.data;
  const mp = mData.data;
  let minX = W,
    minY = H,
    maxX = 0,
    maxY = 0,
    area = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = (mp[i] + mp[i + 1] + mp[i + 2]) / 3;
      let a = 0;
      if (lum >= 180) a = 1;
      else if (lum <= 60) a = 0;
      else a = (lum - 60) / 120;
      px[i + 3] = Math.round(px[i + 3] * a);
      if (a > 0.3) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        area++;
      }
    }
  }

  if (area === 0) {
    // empty mask — return original as fallback
    return { pngUrl: sourceUrl, bbox: { x: 0, y: 0, w: W, h: H }, area: 0 };
  }

  sctx.putImageData(sData, 0, 0);

  // Crop to bbox for smaller PNG
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = bw;
  out.height = bh;
  const octx = out.getContext("2d")!;
  octx.drawImage(sc, minX, minY, bw, bh, 0, 0, bw, bh);

  return {
    pngUrl: out.toDataURL("image/png"),
    bbox: { x: minX, y: minY, w: bw, h: bh },
    area,
  };
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Build a full-size white-on-black mask by pasting a bbox-sized mask
 * (as returned by Gemini segmentation) onto a black canvas at the
 * normalized bbox position, then extract the transparent layer.
 */
export async function extractLayerFromBboxMask(
  sourceUrl: string,
  bboxMaskUrl: string,
  normBox: { x: number; y: number; w: number; h: number },
): Promise<LayerBitmap> {
  const [src, mask] = await Promise.all([loadImg(sourceUrl), loadImg(bboxMaskUrl)]);
  const W = src.naturalWidth;
  const H = src.naturalHeight;
  const bx = Math.round(normBox.x * W);
  const by = Math.round(normBox.y * H);
  const bw = Math.max(1, Math.round(normBox.w * W));
  const bh = Math.max(1, Math.round(normBox.h * H));

  const full = document.createElement("canvas");
  full.width = W;
  full.height = H;
  const fctx = full.getContext("2d")!;
  fctx.fillStyle = "#000";
  fctx.fillRect(0, 0, W, H);
  fctx.drawImage(mask, bx, by, bw, bh);
  const fullMaskUrl = full.toDataURL("image/png");
  return extractLayer(sourceUrl, fullMaskUrl);
}

/**
 * Build a WHITE cover from a mask: wherever the mask is "on", the output pixel
 * is opaque white; elsewhere transparent. Cropped to bbox. Used to hide the
 * corresponding region of the source image so it can be revealed later.
 */
export async function extractWhiteCover(
  sourceUrl: string,
  maskUrl: string,
): Promise<LayerBitmap> {
  const [img, mask] = await Promise.all([loadImg(sourceUrl), loadImg(maskUrl)]);
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const mc = document.createElement("canvas");
  mc.width = W;
  mc.height = H;
  const mctx = mc.getContext("2d", { willReadFrequently: true })!;
  mctx.drawImage(mask, 0, 0, W, H);
  const mData = mctx.getImageData(0, 0, W, H);
  const mp = mData.data;

  const out = new ImageData(W, H);
  const op = out.data;
  let minX = W, minY = H, maxX = 0, maxY = 0, area = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = (mp[i] + mp[i + 1] + mp[i + 2]) / 3;
      let a = 0;
      if (lum >= 180) a = 255;
      else if (lum <= 60) a = 0;
      else a = Math.round(((lum - 60) / 120) * 255);
      if (a > 0) {
        op[i] = 255; op[i + 1] = 255; op[i + 2] = 255; op[i + 3] = a;
        if (a > 76) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          area++;
        }
      }
    }
  }

  if (area === 0) {
    return { pngUrl: "", bbox: { x: 0, y: 0, w: 0, h: 0 }, area: 0 };
  }

  // Dilate bbox by a few px so cover fully hides anti-aliased edges.
  const PAD = 4;
  minX = Math.max(0, minX - PAD);
  minY = Math.max(0, minY - PAD);
  maxX = Math.min(W - 1, maxX + PAD);
  maxY = Math.min(H - 1, maxY + PAD);

  const full = document.createElement("canvas");
  full.width = W;
  full.height = H;
  full.getContext("2d")!.putImageData(out, 0, 0);

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const crop = document.createElement("canvas");
  crop.width = bw;
  crop.height = bh;
  crop.getContext("2d")!.drawImage(full, minX, minY, bw, bh, 0, 0, bw, bh);

  return {
    pngUrl: crop.toDataURL("image/png"),
    bbox: { x: minX, y: minY, w: bw, h: bh },
    area,
  };
}

/**
 * Residual cover: any non-white pixel in the source NOT already covered by the
 * given masks becomes white. Guarantees the fully-covered frame reads as blank.
 */
export async function buildResidualCover(
  sourceUrl: string,
  maskUrls: string[],
): Promise<LayerBitmap> {
  const img = await loadImg(sourceUrl);
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const sc = document.createElement("canvas");
  sc.width = W;
  sc.height = H;
  const sctx = sc.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0, W, H);
  const sData = sctx.getImageData(0, 0, W, H).data;

  // Union of mask coverage.
  const cov = new Uint8Array(W * H);
  for (const url of maskUrls) {
    try {
      const m = await loadImg(url);
      const mc = document.createElement("canvas");
      mc.width = W;
      mc.height = H;
      const mctx = mc.getContext("2d", { willReadFrequently: true })!;
      mctx.drawImage(m, 0, 0, W, H);
      const mp = mctx.getImageData(0, 0, W, H).data;
      for (let p = 0, q = 0; p < mp.length; p += 4, q++) {
        const lum = (mp[p] + mp[p + 1] + mp[p + 2]) / 3;
        if (lum >= 120) cov[q] = 1;
      }
    } catch {
      // ignore missing mask
    }
  }

  // Dilate coverage by ~6px so we don't add residual right next to a real mask.
  const R = 6;
  const cov2 = new Uint8Array(cov.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!cov[y * W + x]) continue;
      const x0 = Math.max(0, x - R), x1 = Math.min(W - 1, x + R);
      const y0 = Math.max(0, y - R), y1 = Math.min(H - 1, y + R);
      for (let yy = y0; yy <= y1; yy++)
        for (let xx = x0; xx <= x1; xx++) cov2[yy * W + xx] = 1;
    }
  }

  const out = new ImageData(W, H);
  const op = out.data;
  let minX = W, minY = H, maxX = 0, maxY = 0, area = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const q = y * W + x;
      if (cov2[q]) continue;
      const i = q * 4;
      const r = sData[i], g = sData[i + 1], b = sData[i + 2];
      const minC = Math.min(r, g, b);
      if (minC < 240) {
        op[i] = 255; op[i + 1] = 255; op[i + 2] = 255; op[i + 3] = 255;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        area++;
      }
    }
  }

  if (area === 0) {
    return { pngUrl: "", bbox: { x: 0, y: 0, w: 0, h: 0 }, area: 0 };
  }

  const PAD = 3;
  minX = Math.max(0, minX - PAD);
  minY = Math.max(0, minY - PAD);
  maxX = Math.min(W - 1, maxX + PAD);
  maxY = Math.min(H - 1, maxY + PAD);

  const full = document.createElement("canvas");
  full.width = W;
  full.height = H;
  full.getContext("2d")!.putImageData(out, 0, 0);

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const crop = document.createElement("canvas");
  crop.width = bw;
  crop.height = bh;
  crop.getContext("2d")!.drawImage(full, minX, minY, bw, bh, 0, 0, bw, bh);

  return {
    pngUrl: crop.toDataURL("image/png"),
    bbox: { x: minX, y: minY, w: bw, h: bh },
    area,
  };
}

