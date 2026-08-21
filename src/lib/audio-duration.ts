import { getAudioContextCtor } from "./web-global";

/** Decode a data-URL, blob URL, or http(s) asset and return exact duration in ms. */
export async function probeAudioDurationMs(url: string): Promise<number | null> {
  const viaElement = await probeViaHtmlAudio(url);
  if (viaElement != null) return viaElement;

  try {
    const AC = getAudioContextCtor();
    if (!AC) return null;
    const ctx: AudioContext = new AC();
    try {
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      const ab = await fetch(url).then((r) => r.arrayBuffer());
      const buf = await ctx.decodeAudioData(ab.slice(0));
      if (!buf.duration || !isFinite(buf.duration)) return null;
      return Math.max(80, Math.round(buf.duration * 1000));
    } finally {
      await ctx.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

function probeViaHtmlAudio(url: string): Promise<number | null> {
  if (typeof Audio === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    let settled = false;
    const finish = (ms: number | null) => {
      if (settled) return;
      settled = true;
      a.removeAttribute("src");
      a.load();
      resolve(ms);
    };
    const timer = setTimeout(() => finish(null), 12000);
    a.onloadedmetadata = () => {
      clearTimeout(timer);
      const ms = Math.round((a.duration || 0) * 1000);
      finish(ms > 0 && Number.isFinite(ms) ? Math.max(80, ms) : null);
    };
    a.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    a.src = url;
  });
}
