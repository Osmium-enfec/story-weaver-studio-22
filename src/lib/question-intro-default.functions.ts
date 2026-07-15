import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";

/** Returns cached default intro-screen TTS, generating and saving once if missing. */
export const ensureQuestionIntroDefaultTts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async () => {
    const { ensureDefaultIntroTts } = await import("./question-intro-default.server");
    return ensureDefaultIntroTts();
  });

const CustomIntroInput = z.object({
  text: z.string().min(1).max(500),
});

export const generateQuestionIntroTts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => CustomIntroInput.parse(d))
  .handler(async ({ data }) => {
    const { generateIntroTts } = await import("./question-intro-default.server");
    return generateIntroTts(data.text);
  });
