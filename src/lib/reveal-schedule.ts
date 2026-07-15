import type { SttWord } from "./audio-slice";
import { alignSentences, type SentenceRange } from "./audio-slice";
import type { RevealCover } from "./build-reveal";
import { questionPostSpeechVisualMs } from "./question-scene-layout";

const LEAD_MS = 200;
const DEFAULT_FADE_MS = 700;
const MIN_FADE_MS = 160;
const MAX_FADE_MS = 900;
const DEFAULT_SCENE_HOLD_MS = 2000;
const DEFAULT_SCENE_TRANSITION_MS = 575;

function masterWindowGapMs(scene: {
  holdMs?: number;
  transitionMs?: number;
  kind?: string;
  questionMarkGapMs?: number;
  questionMarkCountdownSec?: number;
}): number {
  const hold =
    scene.kind === "question"
      ? questionPostSpeechVisualMs(scene)
      : scene.holdMs ?? DEFAULT_SCENE_HOLD_MS;
  const transition = scene.transitionMs ?? DEFAULT_SCENE_TRANSITION_MS;
  return hold + transition;
}

/** Hold after the last box finishes fading so footer/content stay on screen. */
export const SCENE_TAIL_MS = 1800;

/** Latest ms when any reveal box is fully visible. */
export function lastRevealEndMs(covers: RevealCover[]): number {
  if (!covers.length) return 0;
  return Math.max(
    0,
    ...covers.map((c) => (c.revealStartMs ?? LEAD_MS) + (c.revealFadeMs ?? DEFAULT_FADE_MS)),
  );
}

/** Spoken clip length — excludes trailing inter-scene gap in master windows. */
export function revealSpeechDurationMs(scene: {
  durationMs?: number;
  startMs?: number;
  endMs?: number;
  masterAudioUrl?: string;
  holdMs?: number;
  transitionMs?: number;
  kind?: string;
  questionMarkGapMs?: number;
  questionMarkCountdownSec?: number;
  revealCovers?: RevealCover[];
}): number {
  let base = 0;
  if (scene.durationMs && scene.durationMs > 0) base = scene.durationMs;
  else if (scene.startMs != null && scene.endMs != null && scene.endMs > scene.startMs) {
    const windowMs = scene.endMs - scene.startMs;
    if (scene.masterAudioUrl) {
      base = Math.max(0, windowMs - masterWindowGapMs(scene));
    } else {
      base = windowMs;
    }
  } else base = 15000;

  if (scene.revealCovers?.length) {
    base = Math.max(base, lastRevealEndMs(scene.revealCovers) + SCENE_TAIL_MS);
  }
  return base;
}

/** Map elapsed ms within a scene window to 0..1 over the spoken clip only. */
export function speechProgressInScene(
  elapsedMsInWindow: number,
  scene: { durationMs?: number },
): number {
  const speechDur = Math.max(1, revealSpeechDurationMs(scene));
  return Math.min(1, Math.max(0, elapsedMsInWindow) / speechDur);
}

/** Split narration into N phrases aligned with box reading order. */
export function splitNarrationFallback(text: string, count: number): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned || count <= 0) return [];
  if (count === 1) return [cleaned];

  const clauseSplit = cleaned
    .split(/(?<=[.!?])\s+|,\s+(?=(?:we|and|then|also|for|with|using)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  if (clauseSplit.length >= count) {
    const out: string[] = [];
    const per = Math.ceil(clauseSplit.length / count);
    for (let i = 0; i < count; i++) {
      out.push(clauseSplit.slice(i * per, (i + 1) * per).join(" "));
    }
    return out.filter(Boolean);
  }

  const words = cleaned.split(/\s+/);
  const perChunk = Math.max(1, Math.ceil(words.length / count));
  const phrases: string[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = words.slice(i * perChunk, (i + 1) * perChunk).join(" ");
    if (chunk) phrases.push(chunk);
  }
  while (phrases.length < count) phrases.push(phrases[phrases.length - 1] ?? cleaned);
  return phrases.slice(0, count);
}

export async function splitNarrationIntoPhrases(
  text: string,
  count: number,
): Promise<string[]> {
  const fallback = splitNarrationFallback(text, count);
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || count <= 1) return fallback;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Split the narration into exactly ${count} short spoken phrases in reading order (top→bottom, left→right for a whiteboard diagram). Each phrase should match one visual element being revealed. Return ONLY JSON: { "phrases": ["...", ...] } with exactly ${count} strings. Preserve original wording; do not paraphrase.`,
          },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        max_tokens: 800,
      }),
    });
    if (!res.ok) return fallback;
    const j = await res.json();
    const raw = j.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed.phrases) ? parsed.phrases.map(String) : [];
    if (arr.length === count) return arr;
    if (arr.length > count) return arr.slice(0, count);
    if (arr.length > 0) {
      while (arr.length < count) arr.push(arr[arr.length - 1]);
      return arr;
    }
  } catch {
    /* use fallback */
  }
  return fallback;
}

export interface RevealScheduleEntry {
  revealStartMs: number;
  revealFadeMs: number;
}

/** Map phrases → STT word timestamps; compress fade when boxes are close together in speech. */
export function alignPhrasesToWords(
  phrases: string[],
  words: SttWord[],
  sceneDurationMs: number,
): SentenceRange[] {
  const w = words.filter((x) => (x.type ?? "word") === "word" && x.text.trim().length > 0);
  const durationSec = sceneDurationMs / 1000;
  if (!w.length) {
    return phrases.map((_, i) => {
      const t = phrases.length <= 1 ? 0 : (i / Math.max(1, phrases.length - 1)) * durationSec * 0.92;
      return { start: t, end: t };
    });
  }

  const ranges = alignSentences(phrases, w);
  const lastEnd = w[w.length - 1]?.end ?? durationSec;
  const collapsed = ranges.filter((r) => Math.abs(r.start - lastEnd) < 0.15).length;
  const dupStart = ranges.filter((r) => Math.abs(r.start - (ranges[0]?.start ?? 0)) < 0.05).length;

  if (collapsed > Math.max(2, phrases.length / 2) || dupStart > Math.max(2, phrases.length / 2)) {
    const total = Math.min(durationSec, lastEnd * 1.02);
    return phrases.map((_, i) => {
      const t = phrases.length <= 1 ? 0 : (i / Math.max(1, phrases.length - 1)) * total * 0.92;
      return { start: t, end: t };
    });
  }
  return ranges;
}

/** Map phrases → STT word timestamps; compress fade when boxes are close together in speech. */
export function buildRevealSchedules(
  phrases: string[],
  words: SttWord[],
  sceneDurationMs: number,
): RevealScheduleEntry[] {
  const n = phrases.length;
  if (n === 0) return [];
  const ranges = alignPhrasesToWords(phrases, words, sceneDurationMs);
  const schedules: RevealScheduleEntry[] = [];

  for (let i = 0; i < n; i++) {
    const startSec = ranges[i]?.start ?? (i > 0 ? ranges[i - 1]?.end ?? 0 : 0);
    const nextStartSec =
      i + 1 < n ? ranges[i + 1]?.start ?? ranges[i]?.end ?? startSec : sceneDurationMs / 1000;
    const startMs = Math.max(0, Math.round(startSec * 1000));
    const nextStartMs = Math.round(nextStartSec * 1000);
    const gap = Math.max(60, nextStartMs - startMs);
    const fadeMs = Math.min(MAX_FADE_MS, Math.max(MIN_FADE_MS, Math.round(gap * 0.55)));
    schedules.push({
      revealStartMs: Math.max(LEAD_MS, startMs),
      revealFadeMs: fadeMs,
    });
  }

  for (let i = 1; i < schedules.length; i++) {
    const prev = schedules[i - 1];
    const minStart = prev.revealStartMs + Math.round(prev.revealFadeMs * 0.35);
    if (schedules[i].revealStartMs < minStart) {
      schedules[i].revealStartMs = minStart;
      const nextStart =
        i + 1 < schedules.length ? schedules[i + 1].revealStartMs : sceneDurationMs - 100;
      const gap = Math.max(60, nextStart - schedules[i].revealStartMs);
      schedules[i].revealFadeMs = Math.min(
        MAX_FADE_MS,
        Math.max(MIN_FADE_MS, Math.round(gap * 0.55)),
      );
    }
  }

  const lastEnd = schedules[n - 1].revealStartMs + schedules[n - 1].revealFadeMs;
  if (lastEnd > sceneDurationMs - 80 && n > 0) {
    const scale = (sceneDurationMs - LEAD_MS - 80) / Math.max(1, lastEnd - LEAD_MS);
    if (scale < 1) {
      for (let i = 0; i < schedules.length; i++) {
        schedules[i].revealStartMs = Math.round(
          LEAD_MS + (schedules[i].revealStartMs - LEAD_MS) * scale,
        );
        schedules[i].revealFadeMs = Math.max(
          MIN_FADE_MS,
          Math.round(schedules[i].revealFadeMs * scale),
        );
      }
    }
  }

  return schedules;
}

export function defaultUniformSchedule(
  boxCount: number,
  durationMs: number,
): RevealScheduleEntry[] {
  const usable = Math.max(1, durationMs - LEAD_MS - 200);
  const step = usable / Math.max(1, boxCount);
  const fade = Math.min(MAX_FADE_MS, Math.max(MIN_FADE_MS, step * 0.65));
  return Array.from({ length: boxCount }, (_, i) => ({
    revealStartMs: Math.round(LEAD_MS + i * step),
    revealFadeMs: fade,
  }));
}

export function applySchedulesToCovers(
  covers: RevealCover[],
  schedules: RevealScheduleEntry[],
): RevealCover[] {
  return covers.map((c, i) => ({
    ...c,
    revealStartMs: schedules[i]?.revealStartMs,
    revealFadeMs: schedules[i]?.revealFadeMs,
  }));
}

/** 0 = hidden, 1 = fully visible. Uses elapsed speech ms (authoritative clock). */
export function boxRevealOpacityAtMs(
  elapsedMs: number,
  index: number,
  covers: RevealCover[],
): number {
  const c = covers[index];
  const startMs = c.revealStartMs ?? LEAD_MS;
  const fadeMs = c.revealFadeMs ?? DEFAULT_FADE_MS;
  if (elapsedMs < startMs) return 0;
  if (elapsedMs >= startMs + fadeMs) return 1;
  const t = (elapsedMs - startMs) / fadeMs;
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Legacy progress-based opacity (0..1 progress × durationMs). */
export function boxRevealOpacity(
  progress: number,
  index: number,
  covers: RevealCover[],
  durationMs: number,
): number {
  return boxRevealOpacityAtMs(progress * durationMs, index, covers);
}
