/**
 * Local Kokoro TTS for Screen recording 2 only.
 * Talks to /Users/enfecsolutions/kokoro/kokoro-server (downloads the ONNX
 * model once into the Hugging Face cache, then runs offline).
 *
 * Kokoro-82M silently truncates around ~24s / ~460 phonemes. Long narration
 * is split and the MP3s are concatenated so the full text is spoken.
 */
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostDataRoot } from "@/lib/host-storage";
import { normalizeNarrationText } from "@/lib/narration-text";
import { resolveFfmpegBin, runFfmpeg } from "@/lib/ffmpeg-bin";
import { scratchRoot } from "@/lib/runtime-backends";

const KOKORO_ROOT =
  process.env.KOKORO_SERVER_ROOT?.trim() ||
  "/Users/enfecsolutions/kokoro/kokoro-server";
const KOKORO_URL = (
  process.env.KOKORO_TTS_URL?.trim() || "http://127.0.0.1:3333"
).replace(/\/+$/, "");
const KOKORO_VOICES = ["am_michael", "af_heart"] as const;
type KokoroVoiceId = (typeof KOKORO_VOICES)[number];
const KOKORO_VOICE: KokoroVoiceId = KOKORO_VOICES.includes(
  (process.env.KOKORO_VOICE?.trim() || "") as KokoroVoiceId,
)
  ? (process.env.KOKORO_VOICE!.trim() as KokoroVoiceId)
  : "am_michael";
const KOKORO_SPEED = Number(process.env.KOKORO_SPEED || "1") || 1;
/** Stay under Kokoro's ~510-phoneme window (~24s). */
const KOKORO_CHUNK_CHARS = 280;

let starting: Promise<void> | null = null;

function stripEmotionTags(text: string): string {
  return text
    .replace(/\[[a-zA-Z][\w\s-]{0,40}\]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function kokoroHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${KOKORO_URL}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

function spawnKokoroServer() {
  const logDir = path.join(hostDataRoot(), "kokoro");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "kokoro-server.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn("npm", ["start"], {
    cwd: KOKORO_ROOT,
    env: {
      ...process.env,
      PORT: new URL(KOKORO_URL).port || "3333",
      HOST: "127.0.0.1",
      KOKORO_DTYPE: process.env.KOKORO_DTYPE?.trim() || "q8",
    },
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
}

async function ensureKokoroServer(): Promise<void> {
  if (await kokoroHealth()) return;
  if (!existsSync(path.join(KOKORO_ROOT, "package.json"))) {
    throw new Error(
      `Kokoro server not found at ${KOKORO_ROOT}. Clone/install kokoro-server there first.`,
    );
  }
  if (!starting) {
    starting = (async () => {
      spawnKokoroServer();
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (await kokoroHealth()) return;
      }
      throw new Error(
        "Kokoro local TTS did not become ready (first run downloads ~90 MB). Check .data/kokoro/kokoro-server.log.",
      );
    })().finally(() => {
      starting = null;
    });
  }
  await starting;
}

function splitKokoroText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (cleaned.length <= KOKORO_CHUNK_CHARS) return [cleaned];

  const sentences = cleaned
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pieces = sentences.length ? sentences : [cleaned];
  const out: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };

  for (const piece of pieces) {
    if (piece.length > KOKORO_CHUNK_CHARS) {
      flush();
      const words = piece.split(/\s+/).filter(Boolean);
      let line = "";
      for (const word of words) {
        if (line && line.length + word.length + 1 > KOKORO_CHUNK_CHARS) {
          out.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) out.push(line);
      continue;
    }
    if (buf && buf.length + piece.length + 1 > KOKORO_CHUNK_CHARS) flush();
    buf = buf ? `${buf} ${piece}` : piece;
  }
  flush();
  return out.length ? out : [cleaned];
}

async function requestKokoroMp3(text: string, voice: KokoroVoiceId): Promise<Buffer> {
  const res = await fetch(`${KOKORO_URL}/v1/tts/file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice,
      speed: KOKORO_SPEED,
      format: "mp3",
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kokoro TTS failed: ${res.status} ${err.slice(0, 240)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 64) throw new Error("Kokoro returned empty audio");
  return buf;
}

async function concatKokoroMp3s(parts: Buffer[]): Promise<Buffer> {
  if (parts.length === 1) return parts[0]!;
  const ffmpegBin = await resolveFfmpegBin();
  const dir = path.join(scratchRoot(), "kokoro-concat", randomUUID());
  mkdirSync(dir, { recursive: true });
  try {
    const files = parts.map((buf, i) => {
      const file = path.join(dir, `${String(i).padStart(3, "0")}.mp3`);
      writeFileSync(file, buf);
      return file;
    });
    const listPath = path.join(dir, "concat.txt");
    writeFileSync(
      listPath,
      files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
    );
    const outPath = path.join(dir, "out.mp3");
    await runFfmpeg(ffmpegBin, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      "-ar",
      "24000",
      "-ac",
      "1",
      outPath,
    ]);
    return readFileSync(outPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** MP3 bytes from local Kokoro. First call may download the model once. */
export async function generateKokoroMp3Buffer(
  rawText: string,
  voice?: string,
): Promise<Buffer> {
  const text = stripEmotionTags(normalizeNarrationText(rawText));
  if (!text) throw new Error("Narration text is empty after trimming whitespace.");

  await ensureKokoroServer();
  const chosen: KokoroVoiceId = KOKORO_VOICES.includes(voice as KokoroVoiceId)
    ? (voice as KokoroVoiceId)
    : KOKORO_VOICE;

  const chunks = splitKokoroText(text);
  const buffers: Buffer[] = [];
  for (const chunk of chunks) {
    buffers.push(await requestKokoroMp3(chunk, chosen));
  }
  return concatKokoroMp3s(buffers);
}
