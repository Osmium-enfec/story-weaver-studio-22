/**
 * Sanitise narration before it reaches ElevenLabs v3.
 *
 * v3 reads whitespace and line breaks as pacing cues. Text pasted from Word or
 * Google Docs carries whitespace-only lines between every sentence, which
 * fragments the input and makes v3 improvise: one paste with 24 blank-ish lines
 * in 255 chars spoke "Boolean" as "Mouliere's" and "Float" as "Bookmark",
 * differently on every run. Collapsing the text to one clean line makes v3
 * speak it verbatim.
 *
 * Unicode property escapes are used rather than literal characters: these are
 * invisible, so literals would be silently mangled by any editor or formatter
 * that normalises whitespace, quietly breaking this fix.
 */

/** \p{Zl} = U+2028 LINE SEPARATOR, \p{Zp} = U+2029 PARAGRAPH SEPARATOR. */
const LINE_SEPARATORS = /[\p{Zl}\p{Zp}]/gu;

/**
 * Format characters: zero-width space/joiners, word joiner, BOM, soft hyphen.
 * Invisible and meaningless for speech, so dropped rather than made into spaces.
 */
const ZERO_WIDTH = /\p{Cf}/gu;

/**
 * Every Unicode space separator: \p{Zs} covers U+0020, U+00A0, U+1680,
 * U+2000-U+200A, U+202F, U+205F and U+3000. Tab is not Zs, so it is added.
 */
const UNICODE_SPACES = /[\p{Zs}\t]/gu;

export function normalizeNarrationText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(LINE_SEPARATORS, "\n")
    .replace(ZERO_WIDTH, "")
    .replace(UNICODE_SPACES, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/ {2,}/g, " ")
    .trim();
}
