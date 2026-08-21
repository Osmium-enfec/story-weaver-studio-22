/** Background music layered under narration for a stitched part. */
export interface PartBgmConfig {
  url: string;
  /** 0..1 gain relative to narration (not RMS-normalized). */
  volume: number;
  enabled?: boolean;
}

export const DEFAULT_PART_BGM_URL = "/bgm/background-music.mp3";

export const DEFAULT_PART_BGM: PartBgmConfig = {
  url: DEFAULT_PART_BGM_URL,
  volume: 0.25,
  enabled: true,
};

export function resolvePartBgm(bgm: PartBgmConfig | undefined | null): PartBgmConfig | null {
  if (!bgm || bgm.enabled === false || !bgm.url.trim()) return null;
  return {
    url: bgm.url,
    volume: Math.max(0, Math.min(1, bgm.volume)),
    enabled: true,
  };
}

/** Apply mute windows (e.g. intro/outro bumpers that already include music). */
export function partBgmVolumeAtMs(
  bgm: PartBgmConfig,
  tMs: number,
  muteRanges: Array<{ startMs: number; endMs: number }>,
): number {
  const muted = muteRanges.some((r) => tMs >= r.startMs && tMs < r.endMs);
  return muted ? 0 : Math.max(0, Math.min(1, bgm.volume));
}
