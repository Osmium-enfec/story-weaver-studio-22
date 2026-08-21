import { createFileRoute } from "@tanstack/react-router";
import { jsonError, requireApiUser } from "@/lib/api-auth";

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        const key = process.env.ELEVENLABS_API_KEY;
        if (!key) {
          return new Response(
            JSON.stringify({ error: "ELEVENLABS_API_KEY missing" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          return new Response(JSON.stringify({ error: "file required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const upstream = new FormData();
        upstream.append("file", file, file.name || "audio");
        upstream.append("model_id", "scribe_v1");
        upstream.append("timestamps_granularity", "word");

        const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": key },
          body: upstream,
        });
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
