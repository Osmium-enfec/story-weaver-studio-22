/** Decode a data-URL or blob URL and return exact duration in ms. */
export async function probeAudioDurationMs(url: string): Promise<number | null> {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    const ctx: AudioContext = new AC();
    const ab = await fetch(url).then((r) => r.arrayBuffer());
    const buf = await ctx.decodeAudioData(ab.slice(0));
    await ctx.close().catch(() => {});
    if (!buf.duration || !isFinite(buf.duration)) return null;
    return Math.max(80, Math.round(buf.duration * 1000));
  } catch {
    return null;
  }
}
