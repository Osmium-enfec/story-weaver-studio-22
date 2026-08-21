import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { parseQuestionTextServer } from "@/lib/question-parse.server";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ensure-mark-default") }),
  z.object({ action: z.literal("generate-mark-tts"), text: z.string().min(1).max(500) }),
  z.object({ action: z.literal("ensure-intro-default") }),
  z.object({ action: z.literal("generate-intro-tts"), text: z.string().min(1).max(500) }),
  z.object({ action: z.literal("ensure-coding-mark-default") }),
  z.object({ action: z.literal("generate-coding-mark-tts"), text: z.string().min(1).max(500) }),
  z.object({ action: z.literal("ensure-coding-intro-default") }),
  z.object({ action: z.literal("generate-coding-intro-tts"), text: z.string().min(1).max(500) }),
  z.object({
    action: z.literal("ensure-fixed-template-tts"),
    preset: z.enum(["try-question", "try-coding"]),
  }),
  z.object({
    action: z.literal("parse-question"),
    text: z.string().min(10).max(8000),
    kind: z.enum(["mcq", "msq"]).optional(),
  }),
]);

export const Route = createFileRoute("/api/compose-actions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          await requireApiUser(request);
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

        const data = parsed.data;
        try {
          if (data.action === "ensure-mark-default") {
            const { ensureDefaultMarkTts } = await import("@/lib/question-mark-default.server");
            return jsonResponse(await ensureDefaultMarkTts());
          }
          if (data.action === "generate-mark-tts") {
            const { generateMarkTts } = await import("@/lib/question-mark-default.server");
            return jsonResponse(await generateMarkTts(data.text));
          }
          if (data.action === "ensure-intro-default") {
            const { ensureDefaultIntroTts } = await import("@/lib/question-intro-default.server");
            return jsonResponse(await ensureDefaultIntroTts());
          }
          if (data.action === "generate-intro-tts") {
            const { generateIntroTts } = await import("@/lib/question-intro-default.server");
            return jsonResponse(await generateIntroTts(data.text));
          }
          if (data.action === "ensure-coding-mark-default") {
            const { ensureDefaultCodingMarkTts } = await import("@/lib/coding-mark-default.server");
            return jsonResponse(await ensureDefaultCodingMarkTts());
          }
          if (data.action === "generate-coding-mark-tts") {
            const { generateCodingMarkTts } = await import("@/lib/coding-mark-default.server");
            return jsonResponse(await generateCodingMarkTts(data.text));
          }
          if (data.action === "ensure-coding-intro-default") {
            const { ensureDefaultCodingIntroTts } = await import("@/lib/coding-intro-default.server");
            return jsonResponse(await ensureDefaultCodingIntroTts());
          }
          if (data.action === "generate-coding-intro-tts") {
            const { generateCodingIntroTts } = await import("@/lib/coding-intro-default.server");
            return jsonResponse(await generateCodingIntroTts(data.text));
          }
          if (data.action === "ensure-fixed-template-tts") {
            const { ensureFixedTemplateTts } = await import("@/lib/template-fixed-default.server");
            return jsonResponse(await ensureFixedTemplateTts(data.preset));
          }
          return jsonResponse(await parseQuestionTextServer(data.text, data.kind));
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : "Action failed", 500);
        }
      },
    },
  },
});
