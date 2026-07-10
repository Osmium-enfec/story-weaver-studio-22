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
