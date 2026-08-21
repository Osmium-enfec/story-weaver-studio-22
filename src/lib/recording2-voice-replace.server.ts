import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostProjectAssetsRoot } from "@/lib/host-storage";
import { persistProjectLocalFile, resolveUserAssetLocalPath } from "@/lib/project-asset-path";
import { scratchRoot, useSpaces } from "@/lib/runtime-backends";
import {
  probeHasAudioStream,
  probeMediaDurationMs,
  resolveFfmpegBin,
  runFfmpeg,
} from "@/lib/ffmpeg-bin";
import { normalizeElevenLabsWords } from "@/lib/script-stt-sync";
import {
  chunkWordsIntoPhrases,
  phrasesToScript,
  scriptToTimedPhrases,
  stripFillerWords,
  type Recording2Phrase,
} from "@/lib/recording2-fillers";
import { generateRecording2TtsMp3Buffer } from "@/lib/tts.server";

/** Min pause between finished phrases (ms). */
const MIN_GAP_MS = 180;
/** Soft edges so joins aren't clicky. */
const FADE_IN_SEC = 0.012;
const FADE_OUT_SEC = 0.045;
/**
 * If the natural layout overruns the video, stretch the *whole* track once.
 * Cap so we never chipmunk; beyond this we still keep full words and accept
 * a slightly longer audio (preview/export will pad/hold).
 */
const MAX_GLOBAL_SPEED = 1.08;

function safeUnlink(p: string) {
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function atempoFilter(rate: number): string {
  const parts: number[] = [];
  let r = rate;
  while (r > 2) {
    parts.push(2);
    r /= 2;
  }
  while (r < 0.5) {
    parts.push(0.5);
    r /= 0.5;
  }
  parts.push(Math.max(0.5, Math.min(2, r)));
  return parts.map((p) => `atempo=${p.toFixed(4)}`).join(",");
}

/** Ensure phrase text ends cleanly so v3 doesn't trail off mid-thought. */
function finalizePhraseText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return t;
  if (/[.!?…]$/.test(t)) return t;
  return `${t}.`;
}

async function writeSilenceWav(
  ffmpegBin: string,
  durationMs: number,
  outPath: string,
): Promise<void> {
  const sec = Math.max(0.02, durationMs / 1000);
  await runFfmpeg(ffmpegBin, [
    "-y",
    "-f",
    "lavfi",
    "-t",
    sec.toFixed(3),
    "-i",
    "anullsrc=r=44100:cl=mono",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "44100",
    "-ac",
    "1",
    outPath,
  ]);
}

/** Decode TTS mp3 → wav with soft fade in/out. Never trims the spoken content. */
async function mp3ToFadedWav(
  ffmpegBin: string,
  mp3Path: string,
  outWav: string,
): Promise<number> {
  const durMs = await probeMediaDurationMs(ffmpegBin, mp3Path);
  if (!durMs) throw new Error("Could not read TTS clip duration");
  const durSec = durMs / 1000;
  const fadeOutStart = Math.max(0, durSec - FADE_OUT_SEC);
  const filter = [
    `afade=t=in:st=0:d=${FADE_IN_SEC.toFixed(3)}`,
    `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE_OUT_SEC.toFixed(3)}`,
  ].join(",");

  await runFfmpeg(ffmpegBin, [
    "-y",
    "-i",
    mp3Path,
    "-filter:a",
    filter,
    "-acodec",
    "pcm_s16le",
    "-ar",
    "44100",
    "-ac",
    "1",
    outWav,
  ]);
  return (await probeMediaDurationMs(ffmpegBin, outWav)) || durMs;
}

async function concatWavFiles(
  ffmpegBin: string,
  files: string[],
  outPath: string,
): Promise<void> {
  if (files.length === 0) throw new Error("No audio segments to concatenate");
  if (files.length === 1) {
    await runFfmpeg(ffmpegBin, [
      "-y",
      "-i",
      files[0]!,
      "-acodec",
      "pcm_s16le",
      "-ar",
      "44100",
      "-ac",
      "1",
      outPath,
    ]);
    return;
  }
  const listPath = `${outPath}.concat.txt`;
  writeFileSync(
    listPath,
    files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
  );
  try {
    await runFfmpeg(ffmpegBin, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-acodec",
      "pcm_s16le",
      "-ar",
      "44100",
      "-ac",
      "1",
      outPath,
    ]);
  } finally {
    safeUnlink(listPath);
  }
}

/**
 * Fit assembled audio to video length without cutting words mid-phrase:
 * - shorter → pad silence to video length
 * - longer → one gentle global atempo (capped); never atrim speech
 */
async function fitAssembledToVideoDuration(
  ffmpegBin: string,
  wavPath: string,
  videoDurationMs: number,
  outMp3: string,
): Promise<number> {
  const srcMs = await probeMediaDurationMs(ffmpegBin, wavPath);
  if (!srcMs) throw new Error("Could not read assembled audio duration");

  const targetSec = videoDurationMs / 1000;
  let sourceForEncode = wavPath;
  const stretched = `${wavPath}.stretched.wav`;

  if (srcMs > videoDurationMs + 60) {
    const needed = srcMs / videoDurationMs;
    const speed = Math.min(MAX_GLOBAL_SPEED, Math.max(1.001, needed));
    await runFfmpeg(ffmpegBin, [
      "-y",
      "-i",
      wavPath,
      "-filter:a",
      atempoFilter(speed),
      "-acodec",
      "pcm_s16le",
      "-ar",
      "44100",
      "-ac",
      "1",
      stretched,
    ]);
    sourceForEncode = stretched;
  }

  const curMs =
    (await probeMediaDurationMs(ffmpegBin, sourceForEncode)) || srcMs;

  if (curMs < videoDurationMs - 40) {
    const padWav = `${wavPath}.pad.wav`;
    const joined = `${wavPath}.joined.wav`;
    await writeSilenceWav(ffmpegBin, videoDurationMs - curMs, padWav);
    await concatWavFiles(ffmpegBin, [sourceForEncode, padWav], joined);
    await runFfmpeg(ffmpegBin, [
      "-y",
      "-i",
      joined,
      "-t",
      targetSec.toFixed(3),
      "-filter:a",
      "dynaudnorm=f=75:g=10:p=0.9",
      "-acodec",
      "libmp3lame",
      "-q:a",
      "2",
      "-ar",
      "44100",
      "-ac",
      "1",
      outMp3,
    ]);
    safeUnlink(padWav);
    safeUnlink(joined);
    safeUnlink(stretched);
    return videoDurationMs;
  }

  // Exact or still slightly long — encode full speech, never hard-cut words.
  await runFfmpeg(ffmpegBin, [
    "-y",
    "-i",
    sourceForEncode,
    "-filter:a",
    "dynaudnorm=f=75:g=10:p=0.9",
    "-acodec",
    "libmp3lame",
    "-q:a",
    "2",
    "-ar",
    "44100",
    "-ac",
    "1",
    outMp3,
  ]);
  safeUnlink(stretched);
  return (await probeMediaDurationMs(ffmpegBin, outMp3)) || curMs;
}

async function transcribeAudioFile(
  filePath: string,
): Promise<ReturnType<typeof normalizeElevenLabsWords>> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY missing");

  const buf = readFileSync(filePath);
  const upstream = new FormData();
  upstream.append(
    "file",
    new Blob([new Uint8Array(buf)]),
    path.basename(filePath) || "audio.mp3",
  );
  upstream.append("model_id", "scribe_v1");
  upstream.append("timestamps_granularity", "word");
  upstream.append("language_code", "eng");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: upstream,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Transcription failed: ${res.status} ${text.slice(0, 240)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Transcription returned invalid JSON");
  }
  const obj = json as { words?: unknown[] };
  const raw = Array.isArray(obj.words)
    ? obj.words
    : Array.isArray((json as { alignment?: { words?: unknown[] } }).alignment?.words)
      ? (json as { alignment: { words: unknown[] } }).alignment.words
      : [];
  return normalizeElevenLabsWords(raw);
}

async function stripVideoAudio(
  ffmpegBin: string,
  videoPath: string,
  outPath: string,
): Promise<void> {
  try {
    await runFfmpeg(ffmpegBin, [
      "-y",
      "-i",
      videoPath,
      "-c:v",
      "copy",
      "-an",
      outPath,
    ]);
  } catch {
    await runFfmpeg(ffmpegBin, [
      "-y",
      "-i",
      videoPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-an",
      "-movflags",
      "+faststart",
      outPath,
    ]);
  }
  if (!existsSync(outPath) || statSync(outPath).size < 64) {
    throw new Error("Could not create muted video");
  }
}

export interface Recording2VoiceReplaceResult {
  mediaUrl: string;
  audioUrl: string;
  /** Scene clock (max of video / audio so words are never cut). */
  durationMs: number;
  /** True source video length. */
  videoDurationMs: number;
  audioDurationMs: number;
  script: string;
  phraseCount: number;
  phrases?: Recording2EditablePhrase[];
}

export interface Recording2EditablePhrase {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  audioUrl?: string | null;
  audioDurationMs?: number;
}

function projectAssetDir(userId: string, projectId: string): string {
  const dir = useSpaces()
    ? path.join(scratchRoot(), "recording2", userId, projectId)
    : path.join(hostProjectAssetsRoot(), userId, projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function clampPhrases(phrases: Recording2Phrase[]): Recording2Phrase[] {
  return phrases
    .map((p) => ({
      text: finalizePhraseText(p.text),
      startSec: Math.max(0, p.startSec),
      endSec: Math.max(p.startSec + 0.2, p.endSec),
    }))
    .filter((p) => p.text.length > 0);
}

function toEditablePhrases(
  phrases: Recording2Phrase[],
  existing?: Recording2EditablePhrase[],
): Recording2EditablePhrase[] {
  return phrases.map((p, i) => {
    const prev = existing?.[i];
    const sameText =
      prev && prev.text.replace(/\s+/g, " ").trim() === p.text.replace(/\s+/g, " ").trim();
    return {
      id: prev?.id || `r2p-${i + 1}-${randomUUID().slice(0, 8)}`,
      text: p.text,
      startSec: p.startSec,
      endSec: p.endSec,
      audioUrl: sameText ? prev?.audioUrl ?? null : null,
      audioDurationMs: sameText ? prev?.audioDurationMs ?? 0 : 0,
    };
  });
}

async function muteAndPersistVideo(input: {
  userId: string;
  projectId: string;
  videoPath: string;
  ffmpegBin: string;
  dir: string;
}): Promise<string> {
  const mutedName = `${randomUUID()}.mp4`;
  const mutedPath = path.join(input.dir, mutedName);
  const mutedTmp = `${mutedPath}.tmp.mp4`;
  try {
    await stripVideoAudio(input.ffmpegBin, input.videoPath, mutedTmp);
    renameSync(mutedTmp, mutedPath);
    return persistProjectLocalFile({
      userId: input.userId,
      projectId: input.projectId,
      filename: mutedName,
      localPath: mutedPath,
      contentType: "video/mp4",
    });
  } catch (e) {
    safeUnlink(mutedTmp);
    safeUnlink(mutedPath);
    throw e;
  }
}

async function persistPhraseMp3(input: {
  userId: string;
  projectId: string;
  dir: string;
  mp3: Buffer;
}): Promise<{ audioUrl: string; audioDurationMs: number }> {
  const ffmpegBin = await resolveFfmpegBin();
  const name = `${randomUUID()}.mp3`;
  const outPath = path.join(input.dir, name);
  writeFileSync(outPath, input.mp3);
  const audioDurationMs = (await probeMediaDurationMs(ffmpegBin, outPath)) || 0;
  const audioUrl = await persistProjectLocalFile({
    userId: input.userId,
    projectId: input.projectId,
    filename: name,
    localPath: outPath,
    contentType: "audio/mpeg",
  });
  return { audioUrl, audioDurationMs };
}

/** Stage 1: STT → strip fillers → phrase chunks + muted video (no TTS yet). */
export async function runRecording2Transcribe(input: {
  userId: string;
  projectId: string;
  videoUrl: string;
}): Promise<{
  mediaUrl: string;
  videoDurationMs: number;
  phrases: Recording2EditablePhrase[];
  script: string;
}> {
  const videoPath = await resolveUserAssetLocalPath(
    input.videoUrl,
    input.userId,
    `recording2-${input.userId}`,
  );
  if (!videoPath) throw new Error("Video asset not found");

  const ffmpegBin = await resolveFfmpegBin();
  const dir = projectAssetDir(input.userId, input.projectId);
  const workDir = path.join(dir, `.recording2-tx-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
  const extractedAudio = path.join(workDir, "source-audio.mp3");

  try {
    const videoDurationMs = await probeMediaDurationMs(ffmpegBin, videoPath);
    if (!videoDurationMs) throw new Error("Could not read video duration");

    const hasAudio = await probeHasAudioStream(ffmpegBin, videoPath);
    if (!hasAudio) {
      throw new Error(
        "This file has no microphone/audio track (video only). On Mac: Screenshot toolbar (⌘⇧5) → Options → Microphone → choose your mic, then record again. System audio alone is not enough for Screen recording 2.",
      );
    }

    try {
      await runFfmpeg(ffmpegBin, [
        "-y",
        "-i",
        videoPath,
        "-vn",
        "-map",
        "0:a:0",
        "-acodec",
        "libmp3lame",
        "-q:a",
        "4",
        extractedAudio,
      ]);
    } catch (extractErr) {
      const msg = extractErr instanceof Error ? extractErr.message : String(extractErr);
      if (/does not contain any stream|Stream map/i.test(msg)) {
        throw new Error(
          "This file has no usable audio track. Re-record with Microphone enabled in Screenshot options (⌘⇧5 → Options).",
        );
      }
      throw extractErr;
    }
    if (!existsSync(extractedAudio) || statSync(extractedAudio).size < 32) {
      throw new Error(
        "Could not extract mic audio from this video. Re-record with Microphone enabled (⌘⇧5 → Options).",
      );
    }

    const words = await transcribeAudioFile(extractedAudio);
    const cleaned = stripFillerWords(words);
    const phrases = chunkWordsIntoPhrases(cleaned, {
      maxGapSec: 1.1,
      minMergeWords: 8,
    });
    if (phrases.length === 0) {
      throw new Error(
        "No speech found after removing fillers. Try a clearer English recording with mic audio.",
      );
    }

    const clamped = clampPhrases(phrases);
    if (clamped.length === 0) {
      throw new Error("Could not build phrase windows from the transcript.");
    }

    const mediaUrl = await muteAndPersistVideo({
      userId: input.userId,
      projectId: input.projectId,
      videoPath,
      ffmpegBin,
      dir,
    });

    const editable = toEditablePhrases(clamped);
    return {
      mediaUrl,
      videoDurationMs,
      phrases: editable,
      script: phrasesToScript(clamped),
    };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Stage 2a: Kokoro TTS for a single edited phrase. */
export async function runRecording2GeneratePhrase(input: {
  userId: string;
  projectId: string;
  phrase: Recording2EditablePhrase;
  voice?: string;
}): Promise<Recording2EditablePhrase> {
  const text = finalizePhraseText(input.phrase.text);
  if (text.length < 2) throw new Error("Phrase text is empty.");
  const dir = projectAssetDir(input.userId, input.projectId);
  const mp3 = await generateRecording2TtsMp3Buffer(text, input.voice);
  const { audioUrl, audioDurationMs } = await persistPhraseMp3({
    userId: input.userId,
    projectId: input.projectId,
    dir,
    mp3,
  });
  return {
    ...input.phrase,
    text,
    audioUrl,
    audioDurationMs,
  };
}

/**
 * Stage 2b: Generate missing (or all) phrase TTS clips, then assemble the
 * full Kokoro track against the muted video timeline.
 */
export async function runRecording2AssembleFromPhrases(input: {
  userId: string;
  projectId: string;
  videoUrl: string;
  videoDurationMs?: number;
  phrases: Recording2EditablePhrase[];
  /** When set, only these indices are re-TTS'd; others reuse audioUrl when present. */
  regenerateIndices?: number[];
  /** Force TTS for every phrase. */
  regenerateAll?: boolean;
  voice?: string;
}): Promise<{
  mediaUrl: string;
  audioUrl: string;
  durationMs: number;
  videoDurationMs: number;
  audioDurationMs: number;
  script: string;
  phraseCount: number;
  phrases: Recording2EditablePhrase[];
}> {
  if (!input.phrases.length) throw new Error("No transcript chunks to generate.");

  const videoPath = await resolveUserAssetLocalPath(
    input.videoUrl,
    input.userId,
    `recording2-${input.userId}`,
  );
  if (!videoPath) throw new Error("Video asset not found");

  const ffmpegBin = await resolveFfmpegBin();
  const dir = projectAssetDir(input.userId, input.projectId);
  const workDir = path.join(dir, `.recording2-asm-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });

  const finalAudioName = `${randomUUID()}.mp3`;
  const finalAudioPath = path.join(dir, finalAudioName);
  const finalAudioTmp = `${finalAudioPath}.tmp.mp3`;

  try {
    const videoDurationMs =
      input.videoDurationMs && input.videoDurationMs > 0
        ? input.videoDurationMs
        : (await probeMediaDurationMs(ffmpegBin, videoPath)) || 0;
    if (!videoDurationMs) throw new Error("Could not read video duration");

    const regen = new Set(
      input.regenerateAll
        ? input.phrases.map((_, i) => i)
        : (input.regenerateIndices ?? []).filter(
            (i) => i >= 0 && i < input.phrases.length,
          ),
    );

    const nextPhrases: Recording2EditablePhrase[] = [];
    for (let i = 0; i < input.phrases.length; i++) {
      const src = input.phrases[i]!;
      const text = finalizePhraseText(src.text);
      if (text.length < 2) {
        throw new Error(`Chunk ${i + 1} is empty — edit or remove it before generating.`);
      }
      const mustRegen =
        !!input.regenerateAll || regen.has(i) || !src.audioUrl?.trim();
      if (mustRegen) {
        const mp3 = await generateRecording2TtsMp3Buffer(text, input.voice);
        const { audioUrl, audioDurationMs } = await persistPhraseMp3({
          userId: input.userId,
          projectId: input.projectId,
          dir,
          mp3,
        });
        nextPhrases.push({
          ...src,
          text,
          audioUrl,
          audioDurationMs,
        });
      } else {
        nextPhrases.push({ ...src, text });
      }
    }

    // Resolve local paths for phrase mp3s and assemble with silence gaps.
    const segmentFiles: string[] = [];
    let cursorMs = 0;

    for (let i = 0; i < nextPhrases.length; i++) {
      const phrase = nextPhrases[i]!;
      const desiredStartMs = Math.round(phrase.startSec * 1000);
      const startMs = Math.max(desiredStartMs, cursorMs + (i === 0 ? 0 : MIN_GAP_MS));

      if (startMs > cursorMs + 15) {
        const sil = path.join(workDir, `sil-${i}.wav`);
        await writeSilenceWav(ffmpegBin, startMs - cursorMs, sil);
        segmentFiles.push(sil);
      }

      const localMp3 = await resolveUserAssetLocalPath(
        phrase.audioUrl!,
        input.userId,
        `recording2-${input.userId}`,
      );
      if (!localMp3) throw new Error(`Missing audio for chunk ${i + 1}`);
      const speechWav = path.join(workDir, `tts-${i}.wav`);
      const placedMs = await mp3ToFadedWav(ffmpegBin, localMp3, speechWav);
      nextPhrases[i] = { ...phrase, audioDurationMs: placedMs };
      segmentFiles.push(speechWav);
      cursorMs = startMs + placedMs;
    }

    if (cursorMs < videoDurationMs - 20) {
      const sil = path.join(workDir, "sil-end.wav");
      await writeSilenceWav(ffmpegBin, videoDurationMs - cursorMs, sil);
      segmentFiles.push(sil);
    }

    const assembledWav = path.join(workDir, "assembled.wav");
    await concatWavFiles(ffmpegBin, segmentFiles, assembledWav);
    const audioDurationMs = await fitAssembledToVideoDuration(
      ffmpegBin,
      assembledWav,
      videoDurationMs,
      finalAudioTmp,
    );
    renameSync(finalAudioTmp, finalAudioPath);

    // Video may already be muted from transcribe; re-mute if needed.
    let mediaUrl = input.videoUrl;
    const hasAudio = await probeHasAudioStream(ffmpegBin, videoPath);
    if (hasAudio) {
      mediaUrl = await muteAndPersistVideo({
        userId: input.userId,
        projectId: input.projectId,
        videoPath,
        ffmpegBin,
        dir,
      });
    }

    const audioUrl = await persistProjectLocalFile({
      userId: input.userId,
      projectId: input.projectId,
      filename: finalAudioName,
      localPath: finalAudioPath,
      contentType: "audio/mpeg",
    });

    const script = phrasesToScript(
      nextPhrases.map((p) => ({
        text: p.text,
        startSec: p.startSec,
        endSec: p.endSec,
      })),
    );

    return {
      mediaUrl,
      audioUrl,
      durationMs: Math.max(videoDurationMs, audioDurationMs),
      videoDurationMs,
      audioDurationMs,
      script,
      phraseCount: nextPhrases.length,
      phrases: nextPhrases,
    };
  } catch (e) {
    safeUnlink(finalAudioTmp);
    safeUnlink(finalAudioPath);
    throw e;
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Legacy one-shot: STT (or script) → Kokoro → muted video. */
export async function runRecording2VoiceReplace(input: {
  userId: string;
  projectId: string;
  videoUrl: string;
  /** When set, skip STT and regenerate Kokoro audio from this edited narration. */
  script?: string;
  voice?: string;
}): Promise<Recording2VoiceReplaceResult> {
  const scriptOverride = input.script?.replace(/\s+/g, " ").trim() ?? "";
  const videoPath = await resolveUserAssetLocalPath(
    input.videoUrl,
    input.userId,
    `recording2-${input.userId}`,
  );
  if (!videoPath) throw new Error("Video asset not found");
  const ffmpegBin = await resolveFfmpegBin();
  const videoDurationMs = await probeMediaDurationMs(ffmpegBin, videoPath);
  if (!videoDurationMs) throw new Error("Could not read video duration");

  let phrases: Recording2EditablePhrase[];
  let mediaUrl = input.videoUrl;

  if (scriptOverride.length >= 3) {
    const clamped = clampPhrases(
      scriptToTimedPhrases(scriptOverride, videoDurationMs / 1000),
    );
    if (!clamped.length) throw new Error("Narration text is empty after cleaning.");
    phrases = toEditablePhrases(clamped);
  } else {
    const tx = await runRecording2Transcribe(input);
    phrases = tx.phrases;
    mediaUrl = tx.mediaUrl;
  }

  const assembled = await runRecording2AssembleFromPhrases({
    userId: input.userId,
    projectId: input.projectId,
    videoUrl: mediaUrl,
    videoDurationMs,
    phrases,
    regenerateAll: true,
    voice: input.voice,
  });
  return assembled;
}
