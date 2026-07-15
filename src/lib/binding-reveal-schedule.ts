import type { SttWord } from "./audio-slice";
import type { BoxRole, RevealCover } from "./build-reveal";
import type {
  BoxSpeechBinding,
  RevealMatchAudit,
} from "./box-speech-binding";
import {
  contentKeywordsForBinding,
  matchBoxesToSttSequential,
  resolveSingleFooterIndex,
} from "./script-stt-sync";

const LEAD_MS = 200;
const PRE_ROLL_MS = 60;
const DEFAULT_FADE_MS = 700;
const MIN_FADE_MS = 160;
const MAX_FADE_MS = 900;

export interface RevealScheduleEntry {
  revealStartMs: number;
  revealFadeMs: number;
}

export interface BindingScheduleResult {
  schedules: RevealScheduleEntry[];
  audits: RevealMatchAudit[];
}

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s'=]/gu, " ")
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

/** Singular/plural and substring variants for STT-friendly matching. */
function wordForms(term: string): string[] {
  const n = normalizeToken(term);
  if (!n) return [];
  const forms = new Set<string>([n]);
  if (n.endsWith("ies") && n.length > 4) forms.add(`${n.slice(0, -3)}y`);
  if (n.endsWith("es") && n.length > 3) forms.add(n.slice(0, -2));
  if (n.endsWith("s") && n.length > 2) forms.add(n.slice(0, -1));
  if (!n.endsWith("s")) forms.add(`${n}s`);
  if (n.endsWith("y") && n.length > 2) forms.add(`${n.slice(0, -1)}ies`);
  return [...forms].filter((f) => f.length > 1);
}

function tokenMatches(wt: string, target: string): boolean {
  if (!wt || !target) return false;
  for (const a of wordForms(wt)) {
    for (const b of wordForms(target)) {
      if (a === b) return true;
      if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return true;
      if (a.length >= 4 && b.length >= 4 && a.startsWith(b.slice(0, 4))) return true;
    }
  }
  return false;
}

function msFromSpeechSec(startSec: number): number {
  return Math.max(0, Math.round(startSec * 1000) - PRE_ROLL_MS);
}

function termsForBinding(b: BoxSpeechBinding, cover?: RevealCover): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const k = normalizeToken(raw);
    if (k.length > 1 && !seen.has(k)) {
      seen.add(k);
      out.push(raw);
    }
  };
  for (const t of cover?.matchTerms ?? []) push(t);
  for (const t of b.searchTerms) push(t);
  if (b.displayLabel && !/^box \d+$/i.test(b.displayLabel)) push(b.displayLabel);
  for (const p of b.spokenPhrases) push(p);
  return out;
}

function phrasesForBinding(b: BoxSpeechBinding, cover?: RevealCover): string[] {
  const terms = termsForBinding(b, cover);
  const short = terms.filter((t) => normalizeToken(t).split(" ").length === 1);
  const long = terms.filter((t) => normalizeToken(t).split(" ").length > 1);
  return [...short, ...long];
}

/** Single-keyword anchor — best for card labels like String / Integer / Float. */
export function findKeywordAnchor(
  term: string,
  words: SttWord[],
  minSec: number,
  usedAnchors: Set<number>,
  pick: "first" | "last" = "first",
): { startSec: number; phrase: string; anchorIndex: number } | null {
  const key = normalizeToken(term);
  if (key.length < 2) return null;
  const w = speechWords(words);
  let best: { startSec: number; phrase: string; anchorIndex: number } | null = null;

  for (let i = 0; i < w.length; i++) {
    if (w[i].start! < minSec - 0.05) continue;
    if (usedAnchors.has(i)) continue;
    const wt = normalizeToken(w[i].text);
    if (!tokenMatches(wt, key)) continue;
    const hit = { startSec: w[i].start!, phrase: term, anchorIndex: i };
    if (pick === "first") return hit;
    if (!best || hit.startSec >= best.startSec) best = hit;
  }
  return best;
}

/** Find earliest STT anchor for a phrase at or after minSec; skip used anchor indices. */
export function findPhraseAnchor(
  phrase: string,
  words: SttWord[],
  minSec: number,
  usedAnchors: Set<number>,
): { startSec: number; phrase: string; anchorIndex: number } | null {
  const tokens = normalizeToken(phrase)
    .split(" ")
    .filter((t) => t.length > 1);
  if (!tokens.length) return null;
  const w = speechWords(words);
  if (!w.length) return null;

  if (tokens.length === 1) {
    return findKeywordAnchor(tokens[0], words, minSec, usedAnchors, "first");
  }

  const minMatch = Math.max(1, Math.ceil(tokens.length * 0.5));
  let best: { startSec: number; phrase: string; anchorIndex: number } | null = null;

  for (let i = 0; i < w.length; i++) {
    if (w[i].start! < minSec - 0.05) continue;
    if (usedAnchors.has(i)) continue;

    let matched = 0;
    let j = i;
    while (j < w.length && matched < tokens.length) {
      if (usedAnchors.has(j) && matched === 0) break;
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

    if (matched >= minMatch) {
      const startSec = w[i].start!;
      if (!best || startSec < best.startSec) {
        best = { startSec, phrase, anchorIndex: i };
      }
    }
  }

  if (best) return best;

  const key = [...tokens].sort((a, b) => b.length - a.length)[0];
  return findKeywordAnchor(key, words, minSec, usedAnchors, "first");
}

function findPhraseAnchorLatest(
  phrase: string,
  words: SttWord[],
  minSec: number,
  usedAnchors: Set<number>,
): { startSec: number; phrase: string; anchorIndex: number } | null {
  const tokens = normalizeToken(phrase)
    .split(" ")
    .filter((t) => t.length > 1);
  if (!tokens.length) return null;
  if (tokens.length === 1) {
    return findKeywordAnchor(tokens[0], words, minSec, usedAnchors, "last");
  }

  const w = speechWords(words);
  const minMatch = Math.max(1, Math.ceil(tokens.length * 0.5));
  let best: { startSec: number; phrase: string; anchorIndex: number } | null = null;

  for (let i = 0; i < w.length; i++) {
    if (w[i].start! < minSec - 0.05) continue;
    if (usedAnchors.has(i)) continue;

    let matched = 0;
    let j = i;
    while (j < w.length && matched < tokens.length) {
      const wt = normalizeToken(w[j].text);
      if (tokenMatches(wt, tokens[matched])) {
        matched++;
        j++;
      } else if (matched > 0) {
        break;
      } else {
        j++;
      }
    }

    if (matched >= minMatch) {
      const startSec = w[i].start!;
      if (!best || startSec >= best.startSec) {
        best = { startSec, phrase, anchorIndex: i };
      }
    }
  }
  return best;
}

function findBindingMatch(
  binding: BoxSpeechBinding,
  cover: RevealCover,
  words: SttWord[],
  minSec: number,
  usedAnchors: Set<number>,
  pick: "first" | "last" = "first",
): { startSec: number; phrase: string; anchorIndex: number } | null {
  for (const phrase of phrasesForBinding(binding, cover)) {
    const hit =
      pick === "last"
        ? findPhraseAnchorLatest(phrase, words, minSec, usedAnchors)
        : findPhraseAnchor(phrase, words, minSec, usedAnchors);
    if (hit) return hit;
  }
  return null;
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

function interpolateContentMs(
  rank: number,
  total: number,
  loMs: number,
  hiMs: number,
): number {
  if (total <= 1) return loMs + 200;
  const step = (hiMs - loMs) / Math.max(1, total);
  return Math.round(loMs + rank * step);
}

/** Title + subtitle always open; footer always closes; middle keeps STT speech times. */
function enforceStandardRevealTiming(
  schedules: RevealScheduleEntry[],
  covers: RevealCover[],
  bindings: BoxSpeechBinding[],
  sceneDurationMs: number,
  audits: RevealMatchAudit[],
): void {
  const titleIdx = covers.findIndex((c) => bindingForCover(c, bindings).role === "title");
  const subtitleIdx = covers.findIndex((c) => bindingForCover(c, bindings).role === "subtitle");
  const footerIdx = resolveSingleFooterIndex(covers, bindings);

  const titleFade = 450;
  const subtitleFade = 450;

  if (titleIdx >= 0) {
    schedules[titleIdx] = { revealStartMs: LEAD_MS, revealFadeMs: titleFade };
    const a = audits.find((x) => x.boxId === covers[titleIdx].id);
    if (a) {
      a.startMs = LEAD_MS;
      a.phrase = "title";
      a.source = "fixed";
    } else {
      audits.push({
        boxId: covers[titleIdx].id,
        phrase: "title",
        startMs: LEAD_MS,
        source: "fixed",
      });
    }
  }

  const afterTitle = titleIdx >= 0 ? LEAD_MS + titleFade + 120 : LEAD_MS + 80;

  if (subtitleIdx >= 0) {
    let subMs = schedules[subtitleIdx].revealStartMs;
    if (subMs > 4500 || subMs < afterTitle) {
      subMs = afterTitle + 180;
    }
    schedules[subtitleIdx] = { revealStartMs: subMs, revealFadeMs: subtitleFade };
  }

  const openingEnd =
    subtitleIdx >= 0
      ? schedules[subtitleIdx].revealStartMs + subtitleFade
      : titleIdx >= 0
        ? LEAD_MS + titleFade
        : LEAD_MS + 400;

  const middleIndices = covers
    .map((_, i) => i)
    .filter((i) => i !== titleIdx && i !== subtitleIdx && i !== footerIdx);

  const middleEnd =
    middleIndices.length > 0
      ? Math.max(...middleIndices.map((i) => schedules[i].revealStartMs + DEFAULT_FADE_MS))
      : openingEnd;

  if (footerIdx >= 0) {
    let footMs = schedules[footerIdx].revealStartMs;
    const minFoot = middleEnd + 350;
    if (footMs < minFoot) footMs = minFoot;
    footMs = Math.min(footMs, Math.max(minFoot, sceneDurationMs - 150));
    schedules[footerIdx] = { revealStartMs: footMs, revealFadeMs: 500 };
  }
}

function bindingForCover(cover: RevealCover, bindings: BoxSpeechBinding[]): BoxSpeechBinding {
  const hit = bindings.find((b) => b.boxId === cover.id);
  const searchTerms = [
    ...(cover.matchTerms ?? []),
    ...(hit?.searchTerms ?? []),
  ].filter(Boolean);
  const uniqueTerms = [...new Set(searchTerms.map((t) => normalizeToken(t)))].map(
    (k) => searchTerms.find((t) => normalizeToken(t) === k)!,
  );

  if (hit) {
    return {
      ...hit,
      searchTerms: uniqueTerms.length ? uniqueTerms : hit.searchTerms,
    };
  }
  return {
    boxId: cover.id,
    role: cover.role ?? "content",
    displayLabel: cover.label ?? cover.id,
    spokenPhrases: cover.label ? [cover.label] : [],
    searchTerms: uniqueTerms,
  };
}

/**
 * Schedule reveals: ElevenLabs word timestamps + narration script, walked in speech order.
 */
export function buildBindingRevealSchedules(
  covers: RevealCover[],
  bindings: BoxSpeechBinding[],
  words: SttWord[],
  sceneDurationMs: number,
  narrationText: string,
): BindingScheduleResult {
  const n = covers.length;
  const schedules: RevealScheduleEntry[] = Array.from({ length: n }, () => ({
    revealStartMs: LEAD_MS,
    revealFadeMs: DEFAULT_FADE_MS,
  }));
  const audits: RevealMatchAudit[] = [];

  const sequential = matchBoxesToSttSequential(
    covers,
    bindings,
    words,
    narrationText,
  );
  const matchedSet = new Set<number>();

  const usedAnchors = new Set<number>();

  for (const m of sequential) {
    const startMs = msFromSpeechSec(m.startSec);
    schedules[m.boxIndex] = { revealStartMs: startMs, revealFadeMs: DEFAULT_FADE_MS };
    audits.push({
      boxId: covers[m.boxIndex].id,
      phrase: m.phrase,
      startMs,
      source: "speech",
    });
    matchedSet.add(m.boxIndex);
    usedAnchors.add(m.endWordIdx);
  }

  const footerIdx = resolveSingleFooterIndex(covers, bindings);
  const titleIdx = covers.findIndex((c) => bindingForCover(c, bindings).role === "title");
  const subtitleIdx = covers.findIndex((c) => bindingForCover(c, bindings).role === "subtitle");
  const openingEndSec =
    sequential.length > 0
      ? Math.max(
          ...sequential
            .filter((m) => m.boxIndex === titleIdx || m.boxIndex === subtitleIdx)
            .map((m) => m.startSec),
          0.35,
        )
      : 0.35;

  for (let i = 0; i < n; i++) {
    if (matchedSet.has(i)) continue;
    const binding = bindingForCover(covers[i], bindings);
    if (binding.role === "title" || binding.role === "subtitle" || binding.role === "footer") {
      continue;
    }
    for (const kw of contentKeywordsForBinding(binding, covers[i])) {
      const hit = findKeywordAnchor(kw, words, openingEndSec, usedAnchors, "first");
      if (!hit) continue;
      const startMs = msFromSpeechSec(hit.startSec);
      schedules[i] = { revealStartMs: startMs, revealFadeMs: DEFAULT_FADE_MS };
      audits.push({
        boxId: covers[i].id,
        phrase: hit.phrase,
        startMs,
        source: "speech",
      });
      matchedSet.add(i);
      usedAnchors.add(hit.anchorIndex);
      break;
    }
  }
  const matchedTimes = audits
    .filter((a) => a.source !== "interpolated")
    .map((a) => a.startMs)
    .sort((a, b) => a - b);
  const matchedLabels = new Set(
    audits
      .filter((a) => a.source !== "interpolated")
      .map((a) => {
        const cover = covers.find((c) => c.id === a.boxId);
        if (!cover) return "";
        const b = bindingForCover(cover, bindings);
        return normalizeToken(cover.label ?? b.displayLabel);
      })
      .filter((k) => k.length > 2),
  );

  for (let i = 0; i < n; i++) {
    if (matchedSet.has(i)) continue;
    const binding = bindingForCover(covers[i], bindings);
    const labelKey = normalizeToken(covers[i].label ?? binding.displayLabel);
    if (labelKey.length > 2 && matchedLabels.has(labelKey)) continue;
    const lo = matchedTimes.length ? matchedTimes[matchedTimes.length - 1]! + 250 : LEAD_MS + 200;
    const hi =
      footerIdx >= 0 && i !== footerIdx
        ? Math.min(sceneDurationMs - 600, schedules[footerIdx]?.revealStartMs ?? sceneDurationMs - 400)
        : sceneDurationMs - 200;
    const rank = [...Array(n).keys()].filter((j) => !matchedSet.has(j)).indexOf(i);
    const unmapped = n - matchedSet.size;
    const startMs = interpolateContentMs(Math.max(0, rank), unmapped, lo, Math.max(lo + 300, hi));
    schedules[i] = { revealStartMs: startMs, revealFadeMs: DEFAULT_FADE_MS };
    audits.push({
      boxId: covers[i].id,
      phrase: binding.spokenPhrases[0] ?? binding.displayLabel,
      startMs,
      source: "interpolated",
    });
  }

  computeFades(schedules, sceneDurationMs);
  enforceStandardRevealTiming(schedules, covers, bindings, sceneDurationMs, audits);
  computeFades(schedules, sceneDurationMs);
  return { schedules, audits };
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
