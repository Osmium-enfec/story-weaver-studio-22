import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SttWord } from "./audio-slice";
import {
  applySchedulesToCovers,
  defaultUniformSchedule,
} from "./reveal-schedule";
import { buildBindingRevealSchedules } from "./binding-reveal-schedule";
import type { BoxSpeechBinding } from "./box-speech-binding";
import type { RevealCover } from "./build-reveal";
import { normalizeElevenLabsWords } from "./script-stt-sync";

function normalizeSttWords(raw: SttWord[] | unknown[]): SttWord[] {
  if (raw.length && typeof raw[0] === "object" && raw[0] != null && "text" in (raw[0] as object)) {
    const asWords = raw as SttWord[];
    const needsNormalize = asWords.some((w) => w.type != null && w.type !== "word");
    if (needsNormalize) return normalizeElevenLabsWords(raw);
    return asWords
      .filter((w) => w.text?.trim() && w.start != null && w.end != null)
      .map((w) => ({
        ...w,
        start: Number(w.start),
        end: Number(w.end),
        type: w.type ?? "word",
      }));
  }
  return normalizeElevenLabsWords(raw);
}

async function loadAudioBuffer(
  audioUrl: string,
): Promise<{ buf: Buffer; ext: string }> {
  const dataMatch = audioUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (dataMatch) {
    const mime = dataMatch[1];
    const ext = mime.includes("wav") ? "clip.wav" : "clip.mp3";
    return { buf: Buffer.from(dataMatch[2], "base64"), ext };
  }
  if (/^https?:\/\//i.test(audioUrl)) {
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error(`fetch audio ${res.status}`);
    const ct = res.headers.get("content-type") || "audio/mpeg";
    const ext = ct.includes("wav") ? "clip.wav" : "clip.mp3";
    return { buf: Buffer.from(await res.arrayBuffer()), ext };
  }
  throw new Error("audio must be data: or https: URL");
}

async function transcribeBuffer(buf: Buffer, filename: string): Promise<SttWord[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY missing");

  const upstream = new FormData();
  upstream.append("file", new Blob([new Uint8Array(buf)]), filename);
  upstream.append("model_id", "scribe_v1");
  upstream.append("timestamps_granularity", "word");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: upstream,
  });
  if (!res.ok) throw new Error(`STT failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const words: SttWord[] = Array.isArray(j.words)
    ? j.words
    : Array.isArray(j?.transcription?.words)
      ? j.transcription.words
      : [];
  return normalizeSttWords(words);
}

const BindingSchema = z.object({
  boxId: z.string(),
  role: z.enum(["title", "subtitle", "footer", "content", "hub"]),
  displayLabel: z.string(),
  spokenPhrases: z.array(z.string()),
  searchTerms: z.array(z.string()),
});

const SttWordInput = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  type: z.string().optional(),
});

const ScheduleInput = z
  .object({
    words: z.array(SttWordInput).optional(),
    audioUrl: z.string().min(20).optional(),
    narrationText: z.string().min(1),
    boxCount: z.number().int().min(1).max(30),
    durationMs: z.number().min(200),
    clipStartMs: z.number().min(0).optional(),
    clipEndMs: z.number().min(0).optional(),
    bindings: z.array(BindingSchema).min(1),
    covers: z.array(
      z.object({
        id: z.string(),
        pngUrl: z.string(),
        bbox: z.object({
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
        }),
        role: z.enum(["title", "subtitle", "footer", "content", "hub"]).optional(),
        label: z.string().optional(),
        matchTerms: z.array(z.string()).optional(),
      }),
    ),
  })
  .refine((d) => (d.words?.length ?? 0) > 0 || !!d.audioUrl, {
    message: "Provide words or audioUrl",
  });

function clipWords(
  words: SttWord[],
  clipStartMs?: number,
  clipEndMs?: number,
): SttWord[] {
  if (clipStartMs == null || clipEndMs == null || clipEndMs <= clipStartMs) return words;
  const startSec = clipStartMs / 1000;
  const endSec = clipEndMs / 1000;
  return words
    .filter((w) => w.end! >= startSec && w.start! <= endSec)
    .map((w) => ({
      ...w,
      start: Math.max(0, w.start! - startSec),
      end: Math.min(endSec - startSec, w.end! - startSec),
    }));
}

function applyAuditsToCovers(
  covers: RevealCover[],
  schedules: ReturnType<typeof buildBindingRevealSchedules>["schedules"],
  audits: ReturnType<typeof buildBindingRevealSchedules>["audits"],
): RevealCover[] {
  const auditMap = new Map(audits.map((a) => [a.boxId, a]));
  return covers.map((c, i) => {
    const a = auditMap.get(c.id);
    return {
      ...c,
      revealStartMs: schedules[i]?.revealStartMs,
      revealFadeMs: schedules[i]?.revealFadeMs,
      revealMatchPhrase: a?.phrase,
      revealMatchSource: a?.source,
    };
  });
}

/** Align box reveal times via narration bindings → STT phrase anchors. */
export const scheduleRevealCovers = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => ScheduleInput.parse(d))
  .handler(async ({ data }) => {
    const {
      audioUrl,
      words: inputWords,
      durationMs,
      covers,
      bindings,
      clipStartMs,
      clipEndMs,
    } = data;

    const typedCovers = covers as RevealCover[];
    const typedBindings = bindings as BoxSpeechBinding[];
    let sttOk = false;
    let words: SttWord[] = [];

    try {
      words = inputWords?.length ? normalizeSttWords(inputWords as SttWord[]) : [];
      if (!words.length && audioUrl) {
        const { buf, ext } = await loadAudioBuffer(audioUrl);
        words = await transcribeBuffer(buf, ext);
      }
      words = clipWords(words, clipStartMs, clipEndMs);
      sttOk = words.length > 0;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[reveal-schedule]", msg);
    }

    if (!sttOk) {
      const schedules = defaultUniformSchedule(data.boxCount, durationMs);
      const scheduled = applySchedulesToCovers(typedCovers, schedules);
      return { covers: scheduled, schedules, sttOk: false, audits: [] };
    }

    const { schedules, audits } = buildBindingRevealSchedules(
      typedCovers,
      typedBindings,
      words,
      durationMs,
      data.narrationText,
    );
    const scheduled = applyAuditsToCovers(typedCovers, schedules, audits);
    return { covers: scheduled, schedules, sttOk: true, audits };
  });
