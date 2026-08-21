import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { generateTtsAudioUrl } from "@/lib/tts.server";

const Body = z.object({ text: z.string().min(1).max(4000) });

export const Route = createFileRoute("/api/tts")({
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

        try {
          return jsonResponse(await generateTtsAudioUrl(parsed.data.text));
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : "TTS failed", 500);
        }
      },
    },
  },
});
