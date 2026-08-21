/**
 * Pre-rasterise the house-style SVG references to PNG.
 *
 * Replicate rejects raw SVG (ModelError E006), and there is no canvas on the
 * server, so the SVGs in style-refs/ are converted to PNG here and the PNGs are
 * committed alongside them. Run this whenever a reference SVG changes:
 *
 *   bun scripts/rasterise-style-refs.ts
 *
 * Uses headless Chrome — the same engine as the browser, so output matches what
 * the old client-side rasteriser produced. macOS path; adjust CHROME if needed.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SRC_DIR = path.join(process.cwd(), "style-refs");
const MAX_EDGE = 1024;

function svgDimensions(svg: string): { w: number; h: number } {
  const viewBox = svg.match(/viewBox="([\d.\s-]+)"/)?.[1]?.trim().split(/\s+/);
  if (viewBox?.length === 4) {
    return { w: parseFloat(viewBox[2]), h: parseFloat(viewBox[3]) };
  }
  const w = parseFloat(svg.match(/\bwidth="([\d.]+)/)?.[1] ?? "1024");
  const h = parseFloat(svg.match(/\bheight="([\d.]+)/)?.[1] ?? "1024");
  return { w, h };
}

function rasterise(svgPath: string, outPath: string): { w: number; h: number } {
  const svg = readFileSync(svgPath, "utf8");
  const { w, h } = svgDimensions(svg);
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  // White background per md §2 — SVG transparency would otherwise go black.
  const tmp = mkdtempSync(path.join(tmpdir(), "styleref-"));
  const html = path.join(tmp, "p.html");
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:#fff}
     img{width:${outW}px;height:${outH}px;display:block}</style>
     <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`,
  );

  const res = spawnSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--default-background-color=FFFFFFFF",
      `--screenshot=${outPath}`,
      `--window-size=${outW},${outH}`,
      `file://${html}`,
    ],
    { encoding: "utf8" },
  );
  rmSync(tmp, { recursive: true, force: true });
  if (!existsSync(outPath)) {
    throw new Error(`Chrome produced no PNG for ${path.basename(svgPath)}: ${res.stderr?.slice(0, 200)}`);
  }
  return { w: outW, h: outH };
}

const svgs = existsSync(SRC_DIR)
  ? readdirSync(SRC_DIR).filter((f) => f.toLowerCase().endsWith(".svg")).sort()
  : [];

if (!svgs.length) {
  console.error(`No SVGs found in ${SRC_DIR}`);
  process.exit(1);
}

for (const name of svgs) {
  const svgPath = path.join(SRC_DIR, name);
  const outPath = svgPath.replace(/\.svg$/i, ".png");
  const { w, h } = rasterise(svgPath, outPath);
  const bytes = readFileSync(outPath).length;
  console.log(`${name.padEnd(20)} → ${path.basename(outPath).padEnd(20)} ${w}×${h}  ${(bytes / 1024).toFixed(0)}KB`);
}
console.log(`\n${svgs.length} reference(s) rasterised.`);
