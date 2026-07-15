import type { Scene } from "@/components/VideoPlayer";

/** True when the URL only works in the current browser session. */
export function isEphemeralAssetUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return url.startsWith("blob:") || url.startsWith("data:");
}

export function isPersistedAssetUrl(url: string): boolean {
  return url.startsWith("/api/assets/");
}

/** Static files served from public/ — safe to fetch across sessions. */
export function isPublicAssetUrl(url: string): boolean {
  return (
    url.startsWith("/") &&
    !url.startsWith("/api/") &&
    !url.startsWith("blob:") &&
    !url.startsWith("data:")
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not encode asset"));
    reader.readAsDataURL(blob);
  });
}

function extForAsset(url: string, blob: Blob): string {
  if (blob.type.includes("mpeg") || blob.type.includes("mp3")) return "mp3";
  if (blob.type.includes("wav")) return "wav";
  if (url.includes("mpeg") || url.includes("mp3")) return "mp3";
  return "wav";
}

type PersistFn = (input: {
  url: string;
  projectId: string;
  ext: string;
}) => Promise<string>;

/**
 * Copy blob/data URLs into /api/assets/… so export + preview work after reload.
 * Returns the original URL when already persisted or public.
 */
export async function persistClientAsset(
  url: string | undefined | null,
  projectId: string,
  persist: PersistFn,
  defaultExt = "wav",
): Promise<string | undefined> {
  if (!url) return undefined;
  if (isPersistedAssetUrl(url) || isPublicAssetUrl(url)) return url;
  if (/^https?:\/\//.test(url)) return url;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(
      "Audio asset is no longer available in this session. Re-stitch the part and save again.",
    );
  }
  if (!res.ok) {
    throw new Error(`Could not read audio asset (${res.status}). Re-stitch and save the part.`);
  }
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);
  return persist({
    url: dataUrl,
    projectId,
    ext: extForAsset(url, blob) || defaultExt,
  });
}

/** Persist stitched master track + any ephemeral per-scene audio on a saved part. */
export async function persistPartScenesForSave(
  scenes: Scene[],
  masterAudioUrl: string,
  projectId: string,
  persist: PersistFn,
): Promise<{ masterAudioUrl: string; scenes: Scene[] }> {
  const persistedMaster = await persistClientAsset(masterAudioUrl, projectId, persist, "wav");
  if (!persistedMaster) throw new Error("Missing stitched audio");

  const nextScenes = await Promise.all(
    scenes.map(async (scene) => {
      const questionMarkAudioUrl = scene.questionMarkAudioUrl
        ? await persistClientAsset(scene.questionMarkAudioUrl, projectId, persist, "mp3")
        : undefined;
      const questionIntroAudioUrl = scene.questionIntroAudioUrl
        ? await persistClientAsset(scene.questionIntroAudioUrl, projectId, persist, "mp3")
        : undefined;
      const audioUrl = isEphemeralAssetUrl(scene.audioUrl)
        ? (await persistClientAsset(scene.audioUrl, projectId, persist, "mp3")) ?? scene.audioUrl
        : scene.audioUrl;

      return {
        ...scene,
        masterAudioUrl: persistedMaster,
        audioUrl,
        ...(questionMarkAudioUrl != null ? { questionMarkAudioUrl } : {}),
        ...(questionIntroAudioUrl != null ? { questionIntroAudioUrl } : {}),
      };
    }),
  );

  return { masterAudioUrl: persistedMaster, scenes: nextScenes };
}
