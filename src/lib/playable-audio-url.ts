import { apiPersistAssetFile } from "@/lib/compose-api";

function mimeFromDataUrl(url: string): string {
  const m = /^data:([^;,]+)/.exec(url);
  return m?.[1]?.trim() || "audio/mpeg";
}

function extFromMime(mime: string): string {
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  return "mp3";
}

/**
 * Safari often fails to play large `data:audio/...;base64,...` URLs in `<audio>`.
 * Prefer a normal `/api/assets/...` URL (or a blob: URL when no project is open).
 */
export async function toPlayableAudioUrl(
  audioUrl: string,
  projectId: string | null | undefined,
): Promise<string> {
  if (!audioUrl.startsWith("data:") && !audioUrl.startsWith("blob:")) {
    return audioUrl;
  }

  const res = await fetch(audioUrl);
  if (!res.ok) throw new Error("Could not read generated audio");
  const buf = await res.arrayBuffer();
  const mime =
    (audioUrl.startsWith("data:") ? mimeFromDataUrl(audioUrl) : "") ||
    res.headers.get("content-type") ||
    "audio/mpeg";
  const blob = new Blob([buf], { type: mime });
  const ext = extFromMime(mime);

  if (projectId) {
    const file = new File([blob], `narration-${Date.now()}.${ext}`, { type: mime });
    return apiPersistAssetFile({ file, projectId, ext });
  }

  return URL.createObjectURL(blob);
}
