import type { SttWord } from "./audio-slice";

/** Non-lexical fillers / hesitation tokens to drop from the transcript. */
const FILLER_TOKENS = new Set([
  "um",
  "umm",
  "ummm",
  "uh",
  "uhh",
  "uhhh",
  "uhm",
  "uhmm",
  "hmm",
  "hm",
  "hmph",
  "mm",
  "mmm",
  "mmhm",
  "mhm",
  "ah",
  "ahh",
  "eh",
  "er",
  "err",
  "erm",
  "huh",
  "ahem",
]);

export function normalizeFillerToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
}

export function isFillerWord(text: string): boolean {
  const t = normalizeFillerToken(text);
  if (!t) return true;
  if (FILLER_TOKENS.has(t)) return true;
  // Stretched forms like "ummmm", "uhhhh"
  if (/^(u+m+|u+h+|h+m+|m+h+m*|e+r+m*|a+h+)$/i.test(t)) return true;
  return false;
}

export function stripFillerWords(words: SttWord[]): SttWord[] {
  return words.filter((w) => !isFillerWord(w.text));
}

export interface Recording2Phrase {
  text: string;
  startSec: number;
  endSec: number;
}

/**
 * Group cleaned words into longer phrases for steadier TTS.
 * Uses wider pause gaps and merges tiny fragments into neighbors.
 */
export function chunkWordsIntoPhrases(
  words: SttWord[],
  opts?: { maxGapSec?: number; minMergeWords?: number },
): Recording2Phrase[] {
  const maxGapSec = opts?.maxGapSec ?? 0.85;
  const minMergeWords = opts?.minMergeWords ?? 5;
  const cleaned = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  if (cleaned.length === 0) return [];

  const raw: Recording2Phrase[] = [];
  let buf: SttWord[] = [cleaned[0]!];

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf
      .map((w) => w.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      buf = [];
      return;
    }
    raw.push({
      text,
      startSec: buf[0]!.start,
      endSec: Math.max(buf[0]!.start + 0.12, buf[buf.length - 1]!.end),
    });
    buf = [];
  };

  for (let i = 1; i < cleaned.length; i++) {
    const prev = buf[buf.length - 1]!;
    const cur = cleaned[i]!;
    const gap = cur.start - prev.end;
    if (gap > maxGapSec) {
      flush();
      buf = [cur];
    } else {
      buf.push(cur);
    }
  }
  flush();

  if (raw.length <= 1) return splitLongPhrases(raw);

  // Merge very short fragments into the previous phrase when the gap is modest.
  const merged: Recording2Phrase[] = [raw[0]!];
  for (let i = 1; i < raw.length; i++) {
    const prev = merged[merged.length - 1]!;
    const cur = raw[i]!;
    const prevWords = prev.text.split(/\s+/).filter(Boolean).length;
    const curWords = cur.text.split(/\s+/).filter(Boolean).length;
    const gap = cur.startSec - prev.endSec;
    if (
      gap <= 1.25 &&
      (prevWords < minMergeWords || curWords < minMergeWords || cur.endSec - cur.startSec < 1.4)
    ) {
      merged[merged.length - 1] = {
        text: `${prev.text} ${cur.text}`.replace(/\s+/g, " ").trim(),
        startSec: prev.startSec,
        endSec: cur.endSec,
      };
    } else {
      merged.push(cur);
    }
  }
  return splitLongPhrases(merged);
}

/** Keep each UI/TTS chunk under Kokoro's ~24s silent truncate window. */
const MAX_PHRASE_WORDS = 32;

function splitLongPhrases(phrases: Recording2Phrase[]): Recording2Phrase[] {
  const out: Recording2Phrase[] = [];
  for (const p of phrases) {
    const words = p.text.split(/\s+/).filter(Boolean);
    if (words.length <= MAX_PHRASE_WORDS) {
      out.push(p);
      continue;
    }
    const span = Math.max(0.25, p.endSec - p.startSec);
    const n = Math.ceil(words.length / MAX_PHRASE_WORDS);
    for (let i = 0; i < n; i++) {
      const slice = words.slice(i * MAX_PHRASE_WORDS, (i + 1) * MAX_PHRASE_WORDS);
      if (!slice.length) continue;
      const t0 = p.startSec + (span * i) / n;
      const t1 = i === n - 1 ? p.endSec : p.startSec + (span * (i + 1)) / n;
      out.push({
        text: slice.join(" "),
        startSec: t0,
        endSec: Math.max(t0 + 0.12, t1),
      });
    }
  }
  return out;
}

export function phrasesToScript(phrases: Recording2Phrase[]): string {
  return phrases
    .map((p) => p.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split an edited narration into timed phrases spread across the video.
 * Used when regenerating Liam voice from user-edited transcript text.
 */
export function scriptToTimedPhrases(
  script: string,
  videoDurationSec: number,
): Recording2Phrase[] {
  const cleaned = script.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  let parts = cleaned
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // One giant sentence → chunk by ~14 words so TTS stays steady.
  if (parts.length <= 1) {
    const words = cleaned.split(/\s+/).filter(Boolean);
    const chunk = 14;
    parts = [];
    for (let i = 0; i < words.length; i += chunk) {
      parts.push(words.slice(i, i + chunk).join(" "));
    }
  }

  const dur = Math.max(0.5, videoDurationSec);
  const weights = parts.map((p) => Math.max(1, p.split(/\s+/).filter(Boolean).length));
  const total = weights.reduce((a, b) => a + b, 0);
  const phrases: Recording2Phrase[] = [];
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const share = weights[i]! / total;
    const span = Math.max(0.35, share * dur);
    const startSec = cursor;
    const endSec = Math.min(dur, cursor + span);
    phrases.push({ text: parts[i]!, startSec, endSec });
    cursor = endSec;
  }
  return splitLongPhrases(phrases);
}
