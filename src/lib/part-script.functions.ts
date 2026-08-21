import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import { generatePartScriptPlan } from "@/lib/part-script-generate.server";

const Input = z.object({
  topic: z.string().min(8).max(8000),
  courseTitle: z.string().max(200).optional(),
  episodeTitle: z.string().max(200).optional(),
  partTitle: z.string().max(200).optional(),
  includeCodingPractice: z.boolean().optional(),
});

export const generatePartScriptFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    const { plan, durationMs } = await generatePartScriptPlan({
      topic: data.topic,
      courseTitle: data.courseTitle,
      episodeTitle: data.episodeTitle,
      partTitle: data.partTitle,
      includeCodingPractice: data.includeCodingPractice,
    });
    return { plan, durationMs };
  });
