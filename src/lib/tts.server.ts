import { generateKokoroMp3Buffer } from "@/lib/kokoro-tts.server";
import { normalizeNarrationText } from "@/lib/narration-text";

const ELEVEN_VOICE_ID = "TX3LPaxmHKxFdv7VOQHJ";
const ELEVEN_MODEL = "eleven_v3";

type TtsVoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
};

const DEFAULT_VOICE_SETTINGS: TtsVoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.5,
  use_speaker_boost: true,
};

async function generateTtsMp3(
  rawText: string,
  opts: {
    voiceSettings: TtsVoiceSettings;
    /** Append trailing ellipsis cue used by image/code narration pacing. */
    appendEllipsisCue?: boolean;
  },
): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY missing");

  const text = normalizeNarrationText(rawText);
  if (!text) throw new Error("Narration text is empty after trimming whitespace.");

  const spoken = opts.appendEllipsisCue
    ? text.replace(/[.!?…]*\s*$/, "") + " ... "
    : text;

  let res: Response | null = null;
  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: spoken,
          model_id: ELEVEN_MODEL,
          voice_settings: opts.voiceSettings,
        }),
      },
    );
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) {
      lastErr = await res.text();
      try {
        const j = JSON.parse(lastErr) as { detail?: { code?: string; type?: string } };
        if (
          j?.detail?.code === "payment_issue" ||
          (res.status === 401 && j?.detail?.type === "payment_required")
        ) {
          throw new Error(
            "ElevenLabs billing issue — complete your invoice at elevenlabs.io to resume narration.",
          );
        }
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.includes("ElevenLabs billing")) {
          throw parseErr;
        }
      }
      throw new Error(`TTS failed: ${res.status} ${lastErr.slice(0, 240)}`);
    }
    lastErr = await res.text();
    const delay = Math.min(8000, 800 * Math.pow(2, attempt)) + Math.random() * 400;
    await new Promise((r) => setTimeout(r, delay));
  }
  if (!res || !res.ok) throw new Error(`TTS failed: ${res?.status ?? "?"} ${lastErr}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function generateTtsAudioUrl(rawText: string): Promise<{ audioUrl: string }> {
  const buf = await generateTtsMp3(rawText, {
    voiceSettings: DEFAULT_VOICE_SETTINGS,
    appendEllipsisCue: true,
  });
  return { audioUrl: `data:audio/mpeg;base64,${buf.toString("base64")}` };
}

/** Same as generateTtsAudioUrl but returns raw mp3 bytes (for server-side stitching). */
export async function generateTtsMp3Buffer(rawText: string): Promise<Buffer> {
  return generateTtsMp3(rawText, {
    voiceSettings: DEFAULT_VOICE_SETTINGS,
    appendEllipsisCue: true,
  });
}

/**
 * Screen recording 2: local Kokoro (downloaded once on this Mac).
 * Other scene types still use ElevenLabs Liam.
 */
export async function generateRecording2TtsMp3Buffer(
  rawText: string,
  voice?: string,
): Promise<Buffer> {
  return generateKokoroMp3Buffer(rawText, voice);
}
