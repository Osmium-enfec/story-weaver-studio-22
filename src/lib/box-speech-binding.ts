import type { BoxRole } from "./build-reveal";

/** Maps a detected box to phrases the narrator actually speaks. */
export interface BoxSpeechBinding {
  boxId: string;
  role: BoxRole;
  displayLabel: string;
  /** Exact or near-exact phrases copied from the narration script. */
  spokenPhrases: string[];
  /** Keywords to search in STT (synonyms, stems, code fragments). */
  searchTerms: string[];
}

export type RevealMatchSource = "speech" | "interpolated" | "fixed" | "fallback";

export interface RevealMatchAudit {
  boxId: string;
  phrase?: string;
  startMs: number;
  source: RevealMatchSource;
}
