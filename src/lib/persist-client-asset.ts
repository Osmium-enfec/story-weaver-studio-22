import type { Scene } from "@/components/VideoPlayer";
import { createSilentAudioUrl } from "@/lib/audio-concat";
import { apiPersistAssetFile } from "@/lib/compose-api";
import { getStoredSessionToken } from "@/lib/auth-client";

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
  if (blob.type.includes("webm")) return "webm";
  if (blob.type.includes("mp4") || blob.type.includes("quicktime")) return "mp4";
  if (blob.type.includes("png")) return "png";
  if (blob.type.includes("jpeg") || blob.type.includes("jpg")) return "jpg";
  if (blob.type.includes("webp")) return "webp";
  if (url.includes("mpeg") || url.includes("mp3")) return "mp3";
  if (url.includes("webm")) return "webm";
  if (url.includes("mp4") || url.includes(".mov")) return "mp4";
  if (url.includes("png")) return "png";
  if (url.includes("jpg") || url.includes("jpeg")) return "jpg";
  return "wav";
}

function extFromDataUrl(url: string, defaultExt: string): string {
  const mimeMatch = /^data:([^;,]+)/.exec(url);
  const mime = mimeMatch?.[1]?.trim() || "";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4") || mime.includes("quicktime")) return "mp4";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return defaultExt;
}

type PersistFn = (input: {
  url: string;
  projectId: string;
  ext: string;
}) => Promise<string>;

// Avoid re-uploading the same `blob:` URL multiple times during a single
// "Save/Update part" click (can happen when scenes share the same recording
// blob across multiple fields).
const blobPersistMemo = new Map<string, Promise<string | undefined>>();

/** Human label matching the scenes list (1-based index). */
export function sceneListLabel(scene: Scene, index: number): string {
  const name =
    scene.subtitle?.trim() ||
    scene.title?.trim() ||
    scene.narrationText?.trim()?.slice(0, 40) ||
    scene.code?.trim().split("\n")[0]?.slice(0, 40) ||
    scene.kind ||
    "untitled";
  return `Scene ${index + 1} (${name})`;
}

/**
 * Copy blob/data URLs into /api/assets/… so export + preview work after reload.
 * Returns the original URL when already persisted or public.
 */
export async function persistClientAsset(
  url: string | undefined | null,
  projectId: string,
  persist: PersistFn,
  defaultExt = "wav",
  label = "Media",
): Promise<string | undefined> {
  if (!url) return undefined;
  if (isPersistedAssetUrl(url) || isPublicAssetUrl(url)) return url;
  if (/^https?:\/\//.test(url)) return url;

  // data: — write straight to assets (no fetch; large TTS data URLs often break fetch).
  if (url.startsWith("data:")) {
    return persist({
      url,
      projectId,
      ext: extFromDataUrl(url, defaultExt),
    });
  }

  // blob: — must still be alive in this tab.
  let blob: Blob;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`status ${res.status}`);
    }
    blob = await res.blob();
  } catch {
    throw new Error(
      `${label} temporary link expired. Open that scene, re-generate or re-upload if needed, then click Save scene to part again.`,
    );
  }

  const memoKey = `${projectId}::${url}`;
  const existing = blobPersistMemo.get(memoKey);
  if (existing) return existing;

  const p = (async () => {
    // IMPORTANT: upload binary via multipart to avoid base64 data URL slowness
    // and huge request bodies for screen recordings.
    const ext = extForAsset(url, blob) || defaultExt;
    const file = new File([blob], `upload.${ext}`, { type: blob.type || "" });
    // We intentionally call the binary uploader directly; `persist` is still
    // used for JSON/data URLs in other cases.
    return await apiPersistAssetFile({ file, projectId, ext });
  })();

  blobPersistMemo.set(memoKey, p);
  try {
    return await p;
  } finally {
    // Keep memo small: clear so future saves of the same blob don't hold memory.
    blobPersistMemo.delete(memoKey);
  }
}

/** Rebuild a silent bed and persist it (narration-free code typing templates). */
async function persistSilentSceneAudio(
  scene: Scene,
  projectId: string,
  persist: PersistFn,
): Promise<string> {
  const durationMs = Math.max(100, scene.durationMs || 2000);
  // Prefer existing durable / still-alive audio.
  if (scene.audioUrl && !isEphemeralAssetUrl(scene.audioUrl)) {
    return (
      (await persistClientAsset(scene.audioUrl, projectId, persist, "wav", "Silent track")) ??
      scene.audioUrl
    );
  }
  if (scene.audioUrl && isEphemeralAssetUrl(scene.audioUrl)) {
    try {
      const kept = await persistClientAsset(
        scene.audioUrl,
        projectId,
        persist,
        "wav",
        "Silent track",
      );
      if (kept) return kept;
    } catch {
      // Expired blob — recreate below. No TTS needed for silent scenes.
    }
  }
  const silent = await createSilentAudioUrl(durationMs);
  try {
    const persisted = await persistClientAsset(
      silent.url,
      projectId,
      persist,
      "wav",
      "Silent track",
    );
    if (!persisted) throw new Error("Could not save silent track");
    return persisted;
  } finally {
    URL.revokeObjectURL(silent.url);
  }
}

/**
 * Persist every ephemeral media field on a scene to /api/assets/…
 * Call this when clicking "Save scene to part" so stitch never depends on blob/data URLs.
 */
export async function persistSceneAssetsForSave(
  scene: Scene,
  projectId: string,
  persist: PersistFn,
): Promise<Scene> {
  const treatAsSilent =
    scene.silentNarration === true ||
    (scene.kind === "code" &&
      !(scene.narrationText ?? "").trim() &&
      isEphemeralAssetUrl(scene.audioUrl));

  const audioUrl = treatAsSilent
    ? await persistSilentSceneAudio(
        { ...scene, silentNarration: true },
        projectId,
        persist,
      )
    : (await persistClientAsset(scene.audioUrl, projectId, persist, "mp3", "Scene audio")) ??
      scene.audioUrl;

  const mediaUrl = scene.mediaUrl
    ? await persistClientAsset(scene.mediaUrl, projectId, persist, "mp4", "Scene video")
    : undefined;

  const backgroundUrl = scene.backgroundUrl
    ? await persistClientAsset(scene.backgroundUrl, projectId, persist, "png", "Scene background")
    : undefined;

  const compositeThumbUrl = scene.compositeThumbUrl
    ? await persistClientAsset(
        scene.compositeThumbUrl,
        projectId,
        persist,
        "png",
        "Scene thumbnail",
      )
    : undefined;

  const questionMarkAudioUrl = scene.questionMarkAudioUrl
    ? await persistClientAsset(
        scene.questionMarkAudioUrl,
        projectId,
        persist,
        "mp3",
        "Countdown audio",
      )
    : undefined;

  const questionIntroAudioUrl = scene.questionIntroAudioUrl
    ? await persistClientAsset(
        scene.questionIntroAudioUrl,
        projectId,
        persist,
        "mp3",
        "Intro audio",
      )
    : undefined;

  const elements = scene.elements
    ? await Promise.all(
        scene.elements.map(async (el, i) => {
          if (!el.mediaUrl || !isEphemeralAssetUrl(el.mediaUrl)) return el;
          const nextUrl = await persistClientAsset(
            el.mediaUrl,
            projectId,
            persist,
            "png",
            `Layer ${i + 1} image`,
          );
          return nextUrl ? { ...el, mediaUrl: nextUrl } : el;
        }),
      )
    : undefined;

  return {
    ...scene,
    audioUrl,
    ...(mediaUrl != null ? { mediaUrl } : {}),
    ...(backgroundUrl != null ? { backgroundUrl } : {}),
    ...(compositeThumbUrl != null ? { compositeThumbUrl } : {}),
    ...(questionMarkAudioUrl != null ? { questionMarkAudioUrl } : {}),
    ...(questionIntroAudioUrl != null ? { questionIntroAudioUrl } : {}),
    ...(elements != null ? { elements } : {}),
  };
}

/** Persist every scene in a list (e.g. stitch preflight for older projects). */
export async function persistScenesAssetsForSave(
  scenes: Scene[],
  projectId: string,
  persist: PersistFn,
): Promise<Scene[]> {
  const out: Scene[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i]!;
    try {
      out.push(await persistSceneAssetsForSave(s, projectId, persist));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${sceneListLabel(s, i)}: ${msg}`);
    }
  }
  return out;
}

/** Persist stitched master track + any ephemeral per-scene audio/video on a saved part. */
export async function persistPartScenesForSave(
  scenes: Scene[],
  masterAudioUrl: string,
  projectId: string,
  persist: PersistFn,
): Promise<{ masterAudioUrl: string; scenes: Scene[] }> {
  const persistedMaster = await persistClientAsset(
    masterAudioUrl,
    projectId,
    persist,
    "wav",
    "Stitched audio",
  );
  if (!persistedMaster) throw new Error("Missing stitched audio");

  const nextScenes = await persistScenesAssetsForSave(scenes, projectId, persist);
  return {
    masterAudioUrl: persistedMaster,
    scenes: nextScenes.map((scene) => ({
      ...scene,
      masterAudioUrl: persistedMaster,
    })),
  };
}
