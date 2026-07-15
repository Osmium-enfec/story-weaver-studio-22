import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import { buildCompositeImagePrompt } from "@/lib/course-visual-style";
import { generateCompositeImageDirect } from "@/lib/explainer.functions";

const ScriptInput = z
  .object({
    script: z.string().max(4000).optional().default(""),
    title: z.string().max(120).optional(),
    /** Sent verbatim to gpt-image-1 — no extra wrapping or brief step. */
    imagePrompt: z.string().max(8000).optional(),
  })
  .superRefine((data, ctx) => {
    const direct = data.imagePrompt?.trim() ?? "";
    const script = data.script?.trim() ?? "";
    if (direct.length >= 10) return;
    if (script.length >= 3) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide a custom image prompt (10+ chars) or a script (3+ chars).",
    });
  });

function deriveTitle(script: string | undefined, title?: string, imagePrompt?: string): string {
  if (title?.trim()) return title.trim();
  const fromScript = script
    ?.replace(/\s+/g, " ")
    .trim()
    .split(/[.!?]/)
    .at(0)
    ?.split(/\s+/)
    .slice(0, 6)
    .join(" ");
  if (fromScript) return fromScript;
  const firstLine = imagePrompt?.split("\n").map((l) => l.trim()).find(Boolean);
  if (firstLine) return firstLine.slice(0, 60);
  return "Scene";
}

export const generateComposeImage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => ScriptInput.parse(d))
  .handler(async ({ data }) => {
    const directPrompt = data.imagePrompt?.trim();
    const script = data.script?.trim() ?? "";
    const title = deriveTitle(script, data.title, directPrompt);

    // Always send exactly one prompt string — never restructure via a separate brief step.
    const imagePrompt =
      directPrompt || (script ? buildCompositeImagePrompt(script, title) : "");
    if (!imagePrompt) {
      throw new Error("Provide a custom image prompt or a script.");
    }

    const imageUrl = await generateCompositeImageDirect(imagePrompt);
    return {
      imageUrl,
      title,
      imagePrompt,
      promptMode: directPrompt ? ("direct" as const) : ("auto" as const),
    };
  });
