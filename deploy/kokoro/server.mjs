/**
 * Minimal Kokoro TTS HTTP server (same API the app's Mac server exposes).
 *
 *   GET  /health        -> { ok: true, queued, busy, cache, rssMb }
 *   POST /v1/tts/file   -> audio bytes  { text, voice, speed, format }
 *
 * Model weights are downloaded once into HF_HOME (mounted volume).
 *
 * Runs on a small 2 vCPU / 2 GB box, so:
 *  - requests are serialized (one generation at a time) to stop CPU thrashing;
 *  - identical text+voice+speed is served from an on-disk cache;
 *  - the process recycles itself when RSS grows past a cap or after a long
 *    idle period, so the ONNX arena cannot creep up over days
 *    (Docker `restart: unless-stopped` brings it straight back).
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KokoroTTS } from "kokoro-js";

const PORT = Number(process.env.PORT || 3333);
const MODEL = process.env.KOKORO_MODEL || "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = process.env.KOKORO_DTYPE || "q8";
/** Recycle the process once resident memory passes this (MB). */
const MAX_RSS_MB = Number(process.env.KOKORO_MAX_RSS_MB || 1100);
/** Recycle after this many idle minutes (0 disables). */
const IDLE_RECYCLE_MIN = Number(process.env.KOKORO_IDLE_RECYCLE_MIN || 45);
const CACHE_DIR =
  process.env.KOKORO_CACHE_DIR ||
  path.join(process.env.HF_HOME || "/var/lib/kokoro/hf", "tts-cache");
/** Cache budget in MB; oldest files are pruned first. */
const CACHE_MAX_MB = Number(process.env.KOKORO_CACHE_MAX_MB || 512);

// ONNX runtime spawns one thread per core by default and then fights the app
// container for the same 2 vCPUs. Keep it predictable.
const THREADS = Number(process.env.KOKORO_THREADS || 2);
process.env.OMP_NUM_THREADS = String(THREADS);
process.env.ORT_NUM_THREADS = String(THREADS);

try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch {
  /* ignore */
}

let ttsPromise = null;
function getTts() {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL, { dtype: DTYPE }).catch((e) => {
      ttsPromise = null;
      throw e;
    });
  }
  return ttsPromise;
}

/* ------------------------------------------------------------------ queue */

let busy = false;
let queued = 0;
let lastActivity = Date.now();
const waiters = [];

async function withLock(fn) {
  queued += 1;
  if (busy) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  busy = true;
  queued -= 1;
  try {
    return await fn();
  } finally {
    lastActivity = Date.now();
    const next = waiters.shift();
    if (next) next();
    else busy = false;
  }
}

/* ------------------------------------------------------------------ cache */

function cacheKey(text, voice, speed, format) {
  return createHash("sha1")
    .update(`${MODEL}|${DTYPE}|${voice}|${speed}|${format}|${text}`)
    .digest("hex");
}

function cachePath(key, format) {
  return path.join(CACHE_DIR, `${key}.${format === "wav" ? "wav" : "mp3"}`);
}

function readCache(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 64) {
      const now = new Date();
      try {
        fs.utimesSync(file, now, now);
      } catch {
        /* ignore */
      }
      return buf;
    }
  } catch {
    /* miss */
  }
  return null;
}

function writeCache(file, buf) {
  try {
    fs.writeFileSync(`${file}.tmp`, buf);
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    /* cache is best-effort */
  }
  pruneCache();
}

let pruning = false;
function pruneCache() {
  if (pruning) return;
  pruning = true;
  setTimeout(() => {
    try {
      const entries = fs
        .readdirSync(CACHE_DIR)
        .filter((f) => f.endsWith(".mp3") || f.endsWith(".wav"))
        .map((f) => {
          const p = path.join(CACHE_DIR, f);
          const st = fs.statSync(p);
          return { p, size: st.size, at: st.mtimeMs };
        })
        .sort((a, b) => a.at - b.at);
      let total = entries.reduce((sum, e) => sum + e.size, 0);
      const budget = CACHE_MAX_MB * 1024 * 1024;
      while (total > budget && entries.length) {
        const oldest = entries.shift();
        try {
          fs.unlinkSync(oldest.p);
          total -= oldest.size;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    } finally {
      pruning = false;
    }
  }, 50).unref?.();
}

function cacheStats() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => !f.endsWith(".tmp"));
    return { files: files.length };
  } catch {
    return { files: 0 };
  }
}

/* ---------------------------------------------------------------- recycle */

function rssMb() {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

function maybeRecycle() {
  if (busy || queued > 0) return;
  const idleMs = Date.now() - lastActivity;
  const overMemory = rssMb() > MAX_RSS_MB;
  const overIdle = IDLE_RECYCLE_MIN > 0 && idleMs > IDLE_RECYCLE_MIN * 60_000;
  if (!overMemory && !overIdle) return;
  console.log(
    `Recycling Kokoro process (rss=${rssMb()}MB, idle=${Math.round(idleMs / 60_000)}min)`,
  );
  // Docker `restart: unless-stopped` starts a fresh process immediately.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}

setInterval(maybeRecycle, 60_000).unref?.();

/* -------------------------------------------------------------- transcode */

function wavToMp3(wavBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-f",
      "mp3",
      "pipe:1",
    ]);
    const out = [];
    const err = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => err.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg failed (${code}): ${Buffer.concat(err).toString()}`));
    });
    ff.stdin.on("error", () => {});
    ff.stdin.end(wavBuffer);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          busy,
          queued,
          rssMb: rssMb(),
          cache: cacheStats(),
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/v1/tts")) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const text = String(body.text || "").trim();
      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "text is required" }));
        return;
      }
      const voice = String(body.voice || "af_heart");
      const speed = Number(body.speed) || 1;
      const format = String(body.format || "mp3");
      const contentType = format === "wav" ? "audio/wav" : "audio/mpeg";

      const key = cacheKey(text, voice, speed, format);
      const file = cachePath(key, format);
      const cached = readCache(file);
      if (cached) {
        lastActivity = Date.now();
        res.writeHead(200, { "Content-Type": contentType, "X-Kokoro-Cache": "hit" });
        res.end(cached);
        return;
      }

      const audioBuf = await withLock(async () => {
        // Another queued request may have produced the same clip while waiting.
        const again = readCache(file);
        if (again) return again;
        const tts = await getTts();
        const audio = await tts.generate(text, { voice, speed });
        const wav = Buffer.from(audio.toWav());
        const outBuf = format === "wav" ? wav : await wavToMp3(wav);
        writeCache(file, outBuf);
        return outBuf;
      });

      res.writeHead(200, { "Content-Type": contentType, "X-Kokoro-Cache": "miss" });
      res.end(audioBuf);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : "TTS failed" }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Kokoro TTS server listening on :${PORT} (${MODEL}, ${DTYPE}, threads=${THREADS}, maxRss=${MAX_RSS_MB}MB)`,
  );
  // Warm the model so the first request is not a cold download.
  getTts().catch((e) => console.error("Model preload failed:", e));
});
