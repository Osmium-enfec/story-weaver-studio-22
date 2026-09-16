/**
 * Minimal Kokoro TTS HTTP server (same API the app's Mac server exposes).
 *
 *   GET  /health        -> { ok: true }
 *   POST /v1/tts/file   -> audio bytes  { text, voice, speed, format }
 *
 * Model weights are downloaded once into HF_HOME (mounted volume).
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { KokoroTTS } from "kokoro-js";

const PORT = Number(process.env.PORT || 3333);
const MODEL = process.env.KOKORO_MODEL || "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = process.env.KOKORO_DTYPE || "q8";

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
      res.end(JSON.stringify({ ok: true }));
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

      const tts = await getTts();
      const audio = await tts.generate(text, { voice, speed });
      const wav = Buffer.from(audio.toWav());
      if (format === "wav") {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(wav);
        return;
      }
      const mp3 = await wavToMp3(wav);
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(mp3);
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
  console.log(`Kokoro TTS server listening on :${PORT} (${MODEL}, ${DTYPE})`);
  // Warm the model so the first request is not a cold download.
  getTts().catch((e) => console.error("Model preload failed:", e));
});
