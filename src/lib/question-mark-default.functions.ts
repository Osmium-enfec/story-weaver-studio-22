import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";

/** Returns cached default mark-screen TTS, generating and saving once if missing. */
export const ensureQuestionMarkDefaultTts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async () => {
    const { ensureDefaultMarkTts } = await import("./question-mark-default.server");
    return ensureDefaultMarkTts();
  });

const CustomMarkInput = z.object({
  text: z.string().min(1).max(500),
});

export const generateQuestionMarkTts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => CustomMarkInput.parse(d))
  .handler(async ({ data }) => {
    const { generateMarkTts } = await import("./question-mark-default.server");
    return generateMarkTts(data.text);
  });
