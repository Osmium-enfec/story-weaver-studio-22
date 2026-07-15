import type { SttWord } from "./audio-slice";
import type { BoxRole, RevealCover } from "./build-reveal";

const LEAD_MS = 200;
const DEFAULT_FADE_MS = 700;
const MIN_FADE_MS = 160;
const MAX_FADE_MS = 900;
const MIN_CONTENT_GAP_MS = 420;

export interface RevealScheduleEntry {
  revealStartMs: number;
  revealFadeMs: number;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "in",
  "to",
  "for",
  "with",
  "is",
  "are",
  "this",
  "that",
  "we",
  "you",
  "it",
  "as",
  "at",
  "on",
  "by",
  "from",
  "data",
  "type",
  "types",
]);

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function speechWords(words: SttWord[]): SttWord[] {
  return words.filter(
    (x) =>
      (x.type ?? "word") === "word" &&
      x.start != null &&
      x.end != null &&
      normalizeToken(x.text).length > 0,
  );
}

function tokenMatches(wt: string, target: string): boolean {
  if (wt === target) return true;
  if (target.length >= 4 && (wt.includes(target) || target.includes(wt))) return true;
  return false;
}

/** All start times (seconds) where phrase/keyword appears in STT. */
export function findPhraseOccurrencesSec(phrase: string, words: SttWord[]): number[] {
  const tokens = normalizeToken(phrase)
    .split(" ")
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (!tokens.length) return [];
  const w = speechWords(words);
  if (!w.length) return [];

  const hits: number[] = [];
  const minMatch = Math.max(1, Math.ceil(tokens.length * 0.6));

  for (let i = 0; i < w.length; i++) {
    let matched = 0;
    let j = i;
    while (j < w.length && matched < tokens.length) {
      const wt = normalizeToken(w[j].text);
      const target = tokens[matched];
      if (tokenMatches(wt, target)) {
        matched++;
        j++;
      } else if (matched > 0) {
        break;
      } else {
        j++;
      }
    }
    if (matched >= minMatch) hits.push(w[i].start!);
  }

  if (hits.length) return hits;

  const key = [...tokens].sort((a, b) => b.length - a.length)[0];
  if (key.length < 3) return [];
  for (const word of w) {
    const wt = normalizeToken(word.text);
    if (tokenMatches(wt, key)) hits.push(word.start!);
  }
  return hits;
}

/** Pick first occurrence after minSec that is not within minGapMs of used slots. */
export function pickPhraseStartSec(
  phrase: string,
  words: SttWord[],
  minSec: number,
  usedMs: number[],
  minGapMs = MIN_CONTENT_GAP_MS,
): number | null {
  const occ = findPhraseOccurrencesSec(phrase, words);
  for (const t of occ) {
    if (t < minSec) continue;
    const ms = Math.round(t * 1000);
    if (usedMs.every((u) => Math.abs(u - ms) >= minGapMs)) return t;
  }
  return occ.find((t) => t >= minSec) ?? null;
}

function roleOf(c: RevealCover): BoxRole {
  return c.role ?? "content";
}

function termsFor(c: RevealCover): string[] {
  const raw = c.matchTerms?.length
    ? c.matchTerms
    : c.label?.trim()
      ? [c.label.trim()]
      : [];
  return raw
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !/^box \d+$/i.test(t));
}

function computeFades(schedules: RevealScheduleEntry[], durationMs: number): void {
  const order = schedules
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.revealStartMs - b.revealStartMs);
  for (let k = 0; k < order.length; k++) {
    const idx = order[k].i;
    const nextStart = order[k + 1]?.revealStartMs ?? durationMs - 80;
    const gap = Math.max(60, nextStart - schedules[idx].revealStartMs);
    schedules[idx].revealFadeMs = Math.min(
      MAX_FADE_MS,
      Math.max(MIN_FADE_MS, Math.round(gap * 0.52)),
    );
  }
}

function spreadContentFallback(
  rank: number,
  total: number,
  sceneDurationMs: number,
  afterMs: number,
): number {
  const usable = Math.max(800, sceneDurationMs - afterMs - 600);
  const step = total <= 1 ? 0 : usable / Math.max(1, total - 1);
  return Math.round(afterMs + rank * step);
}

/**
 * Schedule reveals by matching each box's label to spoken words.
 * Title → start, subtitle → early, middle content → when named in audio (any order),
 * footer → last.
 */
export function buildSemanticRevealSchedules(
  covers: RevealCover[],
  words: SttWord[],
  sceneDurationMs: number,
  narrationText?: string,
): RevealScheduleEntry[] {
  const n = covers.length;
  if (n === 0) return [];

  const schedules: RevealScheduleEntry[] = Array.from({ length: n }, () => ({
    revealStartMs: LEAD_MS,
    revealFadeMs: DEFAULT_FADE_MS,
  }));

  const subtitleIdx = covers.findIndex((c) => roleOf(c) === "subtitle");
  const footerIdx = covers.findIndex((c) => roleOf(c) === "footer");
  const usedStartsMs: number[] = [];
  const contentEnds: number[] = [];

  const titleIdx = covers.findIndex((c) => roleOf(c) === "title");
  if (titleIdx >= 0) {
    schedules[titleIdx] = { revealStartMs: LEAD_MS, revealFadeMs: 450 };
    usedStartsMs.push(LEAD_MS);
    contentEnds.push(LEAD_MS + 450);
  }

  let subtitleEndMs = LEAD_MS + 650;
  if (subtitleIdx >= 0) {
    const c = covers[subtitleIdx];
    const titleEnd = titleIdx >= 0 ? LEAD_MS + 450 : LEAD_MS;
    let startSec = pickPhraseStartSec(c.label ?? "", words, 0, usedStartsMs, 200);
    if (startSec == null && narrationText) {
      const intro = narrationText.split(/[.!?]/)[0]?.trim();
      if (intro) startSec = pickPhraseStartSec(intro.slice(0, 60), words, 0, usedStartsMs, 200);
    }
    const startMs = Math.max(
      titleEnd + 250,
      startSec != null ? Math.round(startSec * 1000) : titleEnd + 400,
    );
    schedules[subtitleIdx] = { revealStartMs: startMs, revealFadeMs: 450 };
    usedStartsMs.push(startMs);
    subtitleEndMs = startMs + Math.round(schedules[subtitleIdx].revealFadeMs * 0.5);
    contentEnds.push(startMs + schedules[subtitleIdx].revealFadeMs);
  }

  const middleBoxes = covers.filter(
    (x) => !["title", "subtitle", "footer"].includes(roleOf(x)),
  );
  const minContentSec = subtitleEndMs / 1000;

  for (let i = 0; i < n; i++) {
    const c = covers[i];
    const role = roleOf(c);
    if (role === "title" || role === "subtitle" || role === "footer") continue;

    const terms = termsFor(c);
    let startSec: number | null = null;
    for (const term of terms) {
      startSec = pickPhraseStartSec(term, words, minContentSec, usedStartsMs);
      if (startSec != null) break;
    }

    const middleRank = middleBoxes.findIndex((x) => x.id === c.id);
    let startMs =
      startSec != null
        ? Math.round(startSec * 1000)
        : spreadContentFallback(
            middleRank,
            middleBoxes.length,
            sceneDurationMs,
            subtitleEndMs,
          );

    startMs = Math.max(subtitleEndMs, startMs);
    if (usedStartsMs.some((u) => Math.abs(u - startMs) < MIN_CONTENT_GAP_MS)) {
      const maxUsed = usedStartsMs.length ? Math.max(...usedStartsMs) : subtitleEndMs;
      startMs = maxUsed + MIN_CONTENT_GAP_MS;
    }

    schedules[i] = { revealStartMs: startMs, revealFadeMs: DEFAULT_FADE_MS };
    usedStartsMs.push(startMs);
    contentEnds.push(startMs + DEFAULT_FADE_MS);
  }

  if (footerIdx >= 0) {
    const c = covers[footerIdx];
    const minFooterSec = (contentEnds.length ? Math.max(...contentEnds) : subtitleEndMs) / 1000;
    let startSec: number | null = null;
    for (const term of termsFor(c)) {
      startSec = pickPhraseStartSec(term, words, minFooterSec, usedStartsMs, 300);
      if (startSec != null) break;
    }
    let startMs =
      startSec != null
        ? Math.round(startSec * 1000)
        : Math.max(
            (contentEnds.length ? Math.max(...contentEnds) : subtitleEndMs) + 300,
            Math.round(sceneDurationMs * 0.82),
          );
    startMs = Math.min(startMs, sceneDurationMs - 120);
    for (let j = 0; j < n; j++) {
      if (j === footerIdx) continue;
      const end = schedules[j].revealStartMs + schedules[j].revealFadeMs;
      if (end > startMs - 80) startMs = end + 100;
    }
    schedules[footerIdx] = {
      revealStartMs: Math.min(startMs, sceneDurationMs - 100),
      revealFadeMs: 500,
    };
    usedStartsMs.push(schedules[footerIdx].revealStartMs);
  }

  computeFades(schedules, sceneDurationMs);
  return schedules;
}

/** Position heuristics when vision labeling is unavailable. */
export function classifyBoxesHeuristic(covers: RevealCover[]): RevealCover[] {
  return covers.map((c, i) => {
    const cy = c.bbox.y + c.bbox.h / 2;
    let inferred: BoxRole = "content";
    if (c.bbox.y < 0.14 && c.bbox.w > 0.32) inferred = "title";
    else if (c.bbox.y < 0.26 && c.bbox.h < 0.14 && c.bbox.w > 0.28) inferred = "subtitle";
    else if (c.bbox.y > 0.7 && c.bbox.w > 0.42) inferred = "footer";
    else if (c.bbox.h > 0.18 && c.bbox.w > 0.12 && cy > 0.32 && cy < 0.72) inferred = "hub";

    const label = c.label?.trim() || `box ${i + 1}`;
    const matchTerms =
      c.matchTerms?.length ? c.matchTerms : label.startsWith("box ") ? [] : [label];

    return {
      ...c,
      role: c.role ?? inferred,
      label,
      matchTerms,
    };
  });
}
