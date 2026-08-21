/**
 * One-shot: redraw only upload-image scenes onto the last complete Part 2 MP4.
 */
import { appendFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { patchImageScenesOntoMp4 } from "@/lib/native-export-jobs";
import type { ExportJobPayload } from "@/lib/export-job-types";

const logPath = "/tmp/part2-image-patch.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    /* ignore */
  }
  process.stdout.write(line);
}

const jobDir =
  "/Users/enfecsolutions/Enfec Content/divStudio-do-deploy/.data/exports/104e46fe-869e-4189-83eb-1fd4e9e9631b";
const sourceMp4 = path.join(jobDir, "Part 2  Lesson-1080p.mp4");
const outMp4 =
  "/Users/enfecsolutions/Desktop/Part 2  Lesson-1080p-images-fixed.mp4";
const payload = JSON.parse(
  readFileSync(path.join(jobDir, "payload.json"), "utf8"),
) as ExportJobPayload;

for (const leftover of [
  path.join(path.dirname(outMp4), "image-patch-0.mp4"),
  path.join(path.dirname(outMp4), "image-patch-1.mp4"),
  path.join(path.dirname(outMp4), "image-patch-2.mp4"),
]) {
  if (existsSync(leftover)) unlinkSync(leftover);
}

log(`source ${sourceMp4}`);
log(`out ${outMp4}`);
const t0 = Date.now();
await patchImageScenesOntoMp4({
  payload,
  sourceMp4,
  outMp4,
  baseUrl: "http://127.0.0.1:8080",
  bgFrameDir: path.join(jobDir, "bg-frames"),
  onProgress: (stage, ratio) => {
    const pct = Math.round(ratio * 100);
    log(`[${pct}%] ${stage}`);
  },
});
log(`Wrote ${outMp4} in ${Math.round((Date.now() - t0) / 1000)} s`);
