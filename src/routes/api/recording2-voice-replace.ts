import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import {
  runRecording2AssembleFromPhrases,
  runRecording2GeneratePhrase,
  runRecording2Transcribe,
  runRecording2VoiceReplace,
} from "@/lib/recording2-voice-replace.server";

const Phrase = z.object({
  id: z.string().min(1),
  text: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  audioUrl: z.string().nullable().optional(),
  audioDurationMs: z.number().optional(),
});

const Body = z.object({
  projectId: z.string().uuid(),
  videoUrl: z.string().min(1),
  /**
   * - transcribe: STT + fillers + chunks (no TTS)
   * - generatePhrase: Kokoro for one chunk
   * - generateAll: Kokoro for every chunk + assemble
   * - assemble: stitch existing chunk audio (fill missing TTS)
   * - full: legacy one-shot (optional script)
   */
  mode: z
    .enum(["transcribe", "generatePhrase", "generateAll", "assemble", "full"])
    .optional()
    .default("full"),
  script: z.string().optional(),
  phrases: z.array(Phrase).optional(),
  phraseIndex: z.number().int().min(0).optional(),
  videoDurationMs: z.number().optional(),
  voice: z.enum(["am_michael", "af_heart"]).optional(),
});

export const Route = createFileRoute("/api/recording2-voice-replace")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let user;
        try {
          user = await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError("Invalid JSON", 400);
        }
        const parsed = Body.safeParse(body);
        if (!parsed.success) {
          return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
        }

        const {
          projectId,
          videoUrl,
          mode,
          script,
          phrases,
          phraseIndex,
          videoDurationMs,
          voice,
        } = parsed.data;

        try {
          if (mode === "transcribe") {
            const result = await runRecording2Transcribe({
              userId: user.id,
              projectId,
              videoUrl,
            });
            return jsonResponse(result);
          }

          if (mode === "generatePhrase") {
            if (!phrases?.length || phraseIndex == null || !phrases[phraseIndex]) {
              return jsonError("phraseIndex and phrases required", 400);
            }
            const phrase = await runRecording2GeneratePhrase({
              userId: user.id,
              projectId,
              phrase: phrases[phraseIndex]!,
              voice,
            });
            return jsonResponse({ phrase, phraseIndex });
          }

          if (mode === "generateAll" || mode === "assemble") {
            if (!phrases?.length) {
              return jsonError("phrases required", 400);
            }
            const result = await runRecording2AssembleFromPhrases({
              userId: user.id,
              projectId,
              videoUrl,
              videoDurationMs,
              phrases,
              regenerateAll: mode === "generateAll",
              regenerateIndices: mode === "assemble" ? [] : undefined,
              voice,
            });
            return jsonResponse(result);
          }

          // Legacy full pipeline.
          const result = await runRecording2VoiceReplace({
            userId: user.id,
            projectId,
            videoUrl,
            script,
            voice,
          });
          return jsonResponse(result);
        } catch (e) {
          return jsonError(
            e instanceof Error ? e.message : "Voice replace failed",
            500,
          );
        }
      },
    },
  },
});
