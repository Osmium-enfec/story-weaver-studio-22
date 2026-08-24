import { getStoredSessionToken } from "@/lib/auth-client";
import { supabase } from "@/integrations/supabase/client";
import type { ParsedQuestion } from "@/lib/parse-question-text";

async function composeFetch<T>(body: Record<string, unknown>): Promise<T> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");

  const res = await fetch("/api/compose-actions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export async function apiGenerateTts(text: string): Promise<{ audioUrl: string }> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");

  const res = await fetch("/api/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text }),
  });
  const data = (await res.json()) as { audioUrl?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "TTS failed");
  if (!data.audioUrl) throw new Error("TTS failed");
  return { audioUrl: data.audioUrl };
}

export function apiParseQuestion(
  text: string,
  kind?: "mcq" | "msq",
): Promise<ParsedQuestion> {
  return composeFetch({ action: "parse-question", text, kind });
}

/** Shape returned by the mark/intro TTS actions on /api/compose-actions. */
export type TtsResult = { audioUrl: string; text: string; cached: boolean };

export function apiEnsureMarkDefaultTts(): Promise<TtsResult> {
  return composeFetch({ action: "ensure-mark-default" });
}

export function apiGenerateMarkTts(text: string): Promise<TtsResult> {
  return composeFetch({ action: "generate-mark-tts", text });
}

export function apiEnsureIntroDefaultTts(): Promise<TtsResult> {
  return composeFetch({ action: "ensure-intro-default" });
}

export function apiGenerateIntroTts(text: string): Promise<TtsResult> {
  return composeFetch({ action: "generate-intro-tts", text });
}

export function apiEnsureCodingMarkDefaultTts(): Promise<TtsResult> {
  return composeFetch({ action: "ensure-coding-mark-default" });
}

export function apiGenerateCodingMarkTts(text: string): Promise<TtsResult> {
  return composeFetch({ action: "generate-coding-mark-tts", text });
}

export function apiEnsureCodingIntroDefaultTts(): Promise<TtsResult> {
  return composeFetch({ action: "ensure-coding-intro-default" });
}

export function apiGenerateCodingIntroTts(text: string): Promise<TtsResult> {
  return composeFetch({ action: "generate-coding-intro-tts", text });
}

export type FixedTemplateTtsResult = TtsResult & { presetId: string };

export function apiEnsureFixedTemplateTts(
  preset: "try-question" | "try-coding",
): Promise<FixedTemplateTtsResult> {
  return composeFetch({ action: "ensure-fixed-template-tts", preset });
}

export async function apiPersistAsset(input: {
  url: string;
  projectId: string;
  ext: string;
}): Promise<string> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");

  const res = await fetch("/api/persist-asset", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { url?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Persist failed");
  return data.url ?? input.url;
}

/** Persist a File (e.g. screen recording) without building a huge data URL. */
/** Demux audio from a persisted video asset into a playable /api/assets mp3. */
export async function apiExtractVideoAudio(input: {
  projectId: string;
  videoUrl: string;
  durationMs?: number;
}): Promise<{ url: string; durationMs: number }> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");

  const res = await fetch("/api/extract-video-audio", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      projectId: input.projectId,
      videoUrl: input.videoUrl,
      durationMs: input.durationMs,
    }),
  });
  const data = (await res.json()) as {
    url?: string;
    durationMs?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? "Could not extract audio");
  if (!data.url || data.durationMs == null) throw new Error("Could not extract audio");
  return { url: data.url, durationMs: data.durationMs };
}

/** Screen recording 2: staged STT → editable chunks → local Kokoro TTS. */
export type Recording2VoiceMode =
  | "transcribe"
  | "generatePhrase"
  | "generateAll"
  | "assemble"
  | "full";

export interface Recording2PhraseDto {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  audioUrl?: string | null;
  audioDurationMs?: number;
}

export async function apiRecording2VoiceReplace(input: {
  projectId: string;
  videoUrl: string;
  mode?: Recording2VoiceMode;
  /** Legacy / flat regenerate narration. */
  script?: string;
  phrases?: Recording2PhraseDto[];
  phraseIndex?: number;
  videoDurationMs?: number;
  voice?: "am_michael" | "af_heart";
}): Promise<{
  mediaUrl?: string;
  audioUrl?: string;
  durationMs?: number;
  videoDurationMs?: number;
  audioDurationMs?: number;
  script?: string;
  phraseCount?: number;
  phrases?: Recording2PhraseDto[];
  phrase?: Recording2PhraseDto;
  phraseIndex?: number;
}> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");

  const res = await fetch("/api/recording2-voice-replace", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as {
    mediaUrl?: string;
    audioUrl?: string;
    durationMs?: number;
    videoDurationMs?: number;
    audioDurationMs?: number;
    script?: string;
    phraseCount?: number;
    phrases?: Recording2PhraseDto[];
    phrase?: Recording2PhraseDto;
    phraseIndex?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? "Voice replace failed");
  return data;
}

export async function apiPersistAssetFile(input: {
  file: File;
  projectId: string;
  ext?: string;
}): Promise<string> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in required");

  const ext =
    input.ext ??
    (input.file.name.split(".").pop()?.toLowerCase() ||
      (input.file.type.includes("webm") ? "webm" : "mp4"));

  // In the hosted app, ask for a short-lived upload token and send the File
  // directly to object storage. Large recordings must not pass through the
  // app worker because parsing multipart there buffers the whole file.
  const initRes = await fetch("/api/persist-asset", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: "create-direct-upload",
      projectId: input.projectId,
      ext,
    }),
  });
  const init = (await initRes.json()) as {
    direct?: boolean;
    path?: string;
    token?: string;
    url?: string;
    error?: string;
  };
  if (!initRes.ok) throw new Error(init.error ?? "Could not prepare upload");
  if (init.direct) {
    if (!init.path || !init.token || !init.url) throw new Error("Invalid upload details");
    const { error } = await supabase.storage
      .from("project-assets")
      .uploadToSignedUrl(init.path, init.token, input.file, {
        contentType: input.file.type || "application/octet-stream",
      });
    if (error) throw new Error(error.message || "Upload failed");
    return init.url;
  }

  const form = new FormData();
  form.set("projectId", input.projectId);
  form.set("ext", ext);
  form.set("file", input.file);

  const res = await fetch("/api/persist-asset", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const data = (await res.json()) as { url?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Persist failed");
  if (!data.url) throw new Error("Persist failed");
  return data.url;
}
