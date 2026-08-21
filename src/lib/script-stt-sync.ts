import type { SttWord } from "./audio-slice";
import type { BoxSpeechBinding } from "./box-speech-binding";
import type { BoxRole, RevealCover } from "./build-reveal";

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s'=]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
    }
  }
  return false;
}

/** Normalize ElevenLabs Scribe JSON → speech words in seconds. */
export function normalizeElevenLabsWords(raw: unknown[]): SttWord[] {
  const out: SttWord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const w = item as Record<string, unknown>;
    const type = String(w.type ?? "word");
    if (type !== "word") continue;
    const text = String(w.text ?? w.word ?? "").trim();
    if (!text) continue;
    let start = Number(w.start ?? w.start_time ?? w.startTime);
    let end = Number(w.end ?? w.end_time ?? w.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // Some clients return ms — convert if values look like milliseconds.
    if (start > 500 && end > 500) {
      start /= 1000;
      end /= 1000;
    }
    out.push({ text, start, end, type: "word" });
  }
  return out;
}

export function speechWordsOnly(words: SttWord[]): SttWord[] {
  return words.filter(
    (w) => (w.type ?? "word") === "word" && normalizeToken(w.text).length > 0,
  );
}

export interface PhraseAnchor {
  startSec: number;
  endSec: number;
  endWordIdx: number;
  matchedTokens: number;
}

/**
 * Walk STT words in order — match the next spoken phrase without jumping backward.
 * This is the primary sync path: narration clause order ↔ ElevenLabs word timestamps.
 */
export function alignPhraseSequential(
  phrase: string,
  words: SttWord[],
  fromWordIdx: number,
): PhraseAnchor | null {
  const tokens = normalizeToken(phrase)
    .split(" ")
    .filter((t) => t.length > 0);
  if (!tokens.length) return null;
  const w = speechWordsOnly(words);
  if (!w.length || fromWordIdx >= w.length) return null;

  const minMatch = Math.max(1, Math.ceil(tokens.length * 0.4));

  for (let start = fromWordIdx; start < w.length; start++) {
    let ti = 0;
    let wi = start;
    let firstMatch = -1;
    let lastMatch = start;

    while (wi < w.length && ti < tokens.length) {
      const wt = normalizeToken(w[wi].text);
      if (tokenMatches(wt, tokens[ti])) {
        if (firstMatch < 0) firstMatch = wi;
        lastMatch = wi;
        ti++;
        wi++;
      } else if (ti === 0) {
        break;
      } else {
        wi++;
        if (wi - start > tokens.length + 10) break;
      }
    }

    if (ti >= minMatch && firstMatch >= 0) {
      return {
        startSec: w[firstMatch].start!,
        endSec: w[lastMatch]?.end ?? w[firstMatch].start!,
        endWordIdx: lastMatch,
        matchedTokens: ti,
      };
    }
  }

  return null;
}

/** Match a single keyword on the next unused STT words (for card labels like String → strings). */
export function alignKeywordSequential(
  term: string,
  words: SttWord[],
  fromWordIdx: number,
  usedWordIndices?: Set<number>,
): PhraseAnchor | null {
  const key = normalizeToken(term);
  if (key.length < 2) return null;
  const w = speechWordsOnly(words);
  for (let i = fromWordIdx; i < w.length; i++) {
    if (usedWordIndices?.has(i)) continue;
    if (tokenMatches(normalizeToken(w[i].text), key)) {
      return {
        startSec: w[i].start!,
        endSec: w[i].end ?? w[i].start!,
        endWordIdx: i,
        matchedTokens: 1,
      };
    }
  }
  return null;
}

/** First speech-word index at or after `sec`. */
export function wordIndexAtSec(words: SttWord[], sec: number): number {
  const w = speechWordsOnly(words);
  for (let i = 0; i < w.length; i++) {
    if ((w[i].start ?? 0) >= sec - 0.05) return i;
  }
  return w.length;
}

const TYPE_KEYWORDS: Record<string, string[]> = {
  string: ["strings", "string", "text", "textual"],
  integer: ["integers", "integer", "ints", "whole numbers"],
  float: ["floats", "float", "floating", "decimal", "decimals"],
  boolean: ["booleans", "boolean", "bool", "true or false", "yes or no"],
};

/** Keywords for content/hub boxes — label synonyms first (String → strings). */
export function contentKeywordsForBinding(
  binding: BoxSpeechBinding,
  cover: RevealCover,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const k = normalizeToken(raw);
    if (k.length >= 2 && !seen.has(k)) {
      seen.add(k);
      out.push(raw);
    }
  };

  const label = normalizeToken(binding.displayLabel ?? cover.label ?? "");
  for (const [type, kws] of Object.entries(TYPE_KEYWORDS)) {
    if (label.includes(type)) {
      for (const kw of kws) push(kw);
    }
  }
  if (/\bllm\b|language model|large language/i.test(`${label} ${binding.spokenPhrases.join(" ")}`)) {
    push("llm");
    push("language models");
    push("language model");
  }

  for (const t of cover.matchTerms ?? []) push(t);
  for (const t of binding.searchTerms) push(t);
  if (binding.displayLabel && !/^box \d+$/i.test(binding.displayLabel)) {
    push(binding.displayLabel);
  }
  return out;
}

function isContentRole(role: BoxRole): boolean {
  return role === "content" || role === "hub";
}

function bindingForCover(cover: RevealCover, bindings: BoxSpeechBinding[]): BoxSpeechBinding {
  const hit = bindings.find((b) => b.boxId === cover.id);
  if (hit) return hit;
  return {
    boxId: cover.id,
    role: cover.role ?? "content",
    displayLabel: cover.label ?? cover.id,
    spokenPhrases: cover.label ? [cover.label] : [],
    searchTerms: cover.matchTerms ?? [],
  };
}

function phrasesForBinding(binding: BoxSpeechBinding, cover: RevealCover): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const k = normalizeToken(raw);
    if (k.length > 1 && !seen.has(k)) {
      seen.add(k);
      out.push(raw);
    }
  };
  for (const p of binding.spokenPhrases) push(p);
  for (const t of binding.searchTerms) if (normalizeToken(t).split(" ").length > 1) push(t);
  for (const t of cover.matchTerms ?? []) if (normalizeToken(t).split(" ").length > 1) push(t);
  return out;
}

function keywordsForBinding(binding: BoxSpeechBinding, cover: RevealCover): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const k = normalizeToken(raw);
    if (k.length >= 3 && !seen.has(k)) {
      seen.add(k);
      out.push(raw);
    }
  };
  for (const t of cover.matchTerms ?? []) push(t);
  for (const t of binding.searchTerms) push(t);
  if (binding.displayLabel && !/^box \d+$/i.test(binding.displayLabel)) {
    push(binding.displayLabel);
  }
  return out;
}

const ROLE_RANK: Record<BoxRole, number> = {
  title: 0,
  subtitle: 1,
  hub: 2,
  content: 3,
  footer: 4,
};

/** Keep one footer — bottom-most box on the slide. Demote duplicate footer labels. */
export function resolveSingleFooterIndex(covers: RevealCover[], bindings: BoxSpeechBinding[]): number {
  const footerIndices = covers
    .map((c, i) => ({ i, role: bindingForCover(c, bindings).role, y: c.bbox.y + c.bbox.h }))
    .filter(({ role }) => role === "footer");
  if (!footerIndices.length) return -1;
  footerIndices.sort((a, b) => b.y - a.y);
  return footerIndices[0].i;
}

/** Order box indices: title → subtitle → content/hub (narration order) → footer. */
export function orderBoxesByNarration(
  covers: RevealCover[],
  bindings: BoxSpeechBinding[],
  narration: string,
  footerIdx: number,
  titleIdx: number,
  subtitleIdx: number,
): number[] {
  const normNarr = normalizeToken(narration);
  const indices = covers.map((_, i) => i);

  const sortKey = (i: number): number => {
    if (i === titleIdx) return -3_000;
    if (i === subtitleIdx) return -2_000;
    if (i === footerIdx) return 2_000_000 + covers[i].bbox.y;
    const binding = bindingForCover(covers[i], bindings);
    const role = binding.role;

    let best = normNarr.length;
    for (const p of binding.spokenPhrases) {
      const snippet = normalizeToken(p).slice(0, 48);
      if (snippet.length < 3) continue;
      const pos = normNarr.indexOf(snippet);
      if (pos >= 0) best = Math.min(best, pos);
    }
    return best * 10 + (ROLE_RANK[role] ?? 3);
  };

  return indices.sort((a, b) => sortKey(a) - sortKey(b));
}

function resolveTitleSubtitleIndices(
  covers: RevealCover[],
  bindings: BoxSpeechBinding[],
): { titleIdx: number; subtitleIdx: number } {
  const titleIdx = covers.findIndex((c) => bindingForCover(c, bindings).role === "title");
  const subtitleIdx = covers.findIndex((c) => bindingForCover(c, bindings).role === "subtitle");
  return { titleIdx, subtitleIdx };
}

function tryMatchBox(
  boxIndex: number,
  covers: RevealCover[],
  bindings: BoxSpeechBinding[],
  words: SttWord[],
  fromWordIdx: number,
  footerSearch = false,
  usedWordIndices?: Set<number>,
): { match: SequentialMatch | null; nextCursor: number } {
  const cover = covers[boxIndex];
  const binding = bindingForCover(cover, bindings);
  const contentFirst = isContentRole(binding.role) && !footerSearch;

  let hit: PhraseAnchor | null = null;
  let usedPhrase = "";
  let source: "speech" | "keyword" = "speech";

  const tryKeywords = (terms: string[]) => {
    for (const kw of terms) {
      const anchor = footerSearch
        ? alignKeywordFromEnd(kw, words, fromWordIdx)
        : alignKeywordSequential(kw, words, fromWordIdx, usedWordIndices);
      if (anchor) {
        hit = anchor;
        usedPhrase = kw;
        source = "keyword";
        return;
      }
    }
  };

  const tryPhrases = () => {
    for (const phrase of phrasesForBinding(binding, cover)) {
      const anchor = footerSearch
        ? alignPhraseFromEnd(phrase, words, fromWordIdx)
        : alignPhraseSequential(phrase, words, fromWordIdx);
      if (anchor) {
        hit = anchor;
        usedPhrase = phrase;
        source = "speech";
        return;
      }
    }
  };

  if (contentFirst) {
    tryKeywords(contentKeywordsForBinding(binding, cover));
    if (!hit) tryKeywords(keywordsForBinding(binding, cover));
    if (!hit) tryPhrases();
  } else {
    tryPhrases();
    if (!hit) tryKeywords(keywordsForBinding(binding, cover));
  }

  if (!hit) return { match: null, nextCursor: fromWordIdx };

  usedWordIndices?.add(hit.endWordIdx);

  return {
    match: {
      boxIndex,
      startSec: hit.startSec,
      phrase: usedPhrase,
      source,
      endWordIdx: hit.endWordIdx,
    },
    nextCursor: Math.max(fromWordIdx, hit.endWordIdx + 1),
  };
}

/** Match closing phrase — search from the end of the transcript. */
export function alignPhraseFromEnd(
  phrase: string,
  words: SttWord[],
  minFromIdx: number,
): PhraseAnchor | null {
  const w = speechWordsOnly(words);
  if (!w.length) return null;
  let best: PhraseAnchor | null = null;
  for (let start = w.length - 1; start >= minFromIdx; start--) {
    const hit = alignPhraseSequential(phrase, words, start);
    if (hit && (!best || hit.startSec >= best.startSec)) best = hit;
    if (hit && hit.matchedTokens >= normalizeToken(phrase).split(" ").filter(Boolean).length * 0.6) {
      return hit;
    }
  }
  return best;
}

function alignKeywordFromEnd(
  term: string,
  words: SttWord[],
  minFromIdx: number,
): PhraseAnchor | null {
  const w = speechWordsOnly(words);
  const key = normalizeToken(term);
  if (key.length < 3) return null;
  for (let i = w.length - 1; i >= minFromIdx; i--) {
    if (tokenMatches(normalizeToken(w[i].text), key)) {
      return {
        startSec: w[i].start!,
        endSec: w[i].end ?? w[i].start!,
        endWordIdx: i,
        matchedTokens: 1,
      };
    }
  }
  return null;
}

export interface SequentialMatch {
  boxIndex: number;
  startSec: number;
  phrase: string;
  source: "speech" | "keyword";
  endWordIdx: number;
}

/**
 * Map each box → ElevenLabs word timestamp.
 * Standard order: title + subtitle at opening, content/hub in speech order, footer at close.
 */
export function matchBoxesToSttSequential(
  covers: RevealCover[],
  bindings: BoxSpeechBinding[],
  words: SttWord[],
  narration: string,
): SequentialMatch[] {
  const footerIdx = resolveSingleFooterIndex(covers, bindings);
  const { titleIdx, subtitleIdx } = resolveTitleSubtitleIndices(covers, bindings);
  const w = speechWordsOnly(words);
  if (!w.length) return [];

  const matches: SequentialMatch[] = [];
  const usedWordIndices = new Set<number>();
  let cursor = 0;

  const opening = [titleIdx, subtitleIdx].filter((i) => i >= 0);
  for (const boxIndex of opening) {
    const { match, nextCursor } = tryMatchBox(
      boxIndex,
      covers,
      bindings,
      words,
      cursor,
      false,
      usedWordIndices,
    );
    if (match) {
      matches.push(match);
      cursor = nextCursor;
    } else if (boxIndex === titleIdx) {
      matches.push({
        boxIndex,
        startSec: 0,
        phrase: "title",
        source: "speech",
        endWordIdx: Math.min(cursor, w.length - 1),
      });
    }
  }

  const openingEndSec =
    matches.length > 0
      ? Math.max(
          ...matches
            .filter((m) => opening.includes(m.boxIndex))
            .map((m) => m.startSec),
        )
      : 0.35;
  cursor = Math.max(cursor, wordIndexAtSec(words, openingEndSec + 0.05));

  const middleOrder = orderBoxesByNarration(
    covers,
    bindings,
    narration,
    footerIdx,
    titleIdx,
    subtitleIdx,
  ).filter((i) => i !== titleIdx && i !== subtitleIdx && i !== footerIdx);

  for (const boxIndex of middleOrder) {
    const { match, nextCursor } = tryMatchBox(
      boxIndex,
      covers,
      bindings,
      words,
      cursor,
      false,
      usedWordIndices,
    );
    if (match) {
      matches.push(match);
      cursor = nextCursor;
    }
  }

  if (footerIdx >= 0) {
    const footerMin = Math.max(cursor, Math.floor(w.length * 0.45));
    const { match } = tryMatchBox(
      footerIdx,
      covers,
      bindings,
      words,
      footerMin,
      true,
      usedWordIndices,
    );
    if (match) matches.push(match);
  }

  return matches;
}
