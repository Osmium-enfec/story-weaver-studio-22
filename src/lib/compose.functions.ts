import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";
import { buildCompositeImagePrompt } from "@/lib/course-visual-style";
import { houseStyleReferenceUrls } from "@/lib/house-style.server";
import {
  IMAGE_ASPECT_OPTIONS,
  IMAGE_MODEL_OPTIONS,
  generateReplicateImageDataUrl,
  styleLine,
} from "@/lib/replicate-image";

const ScriptInput = z
  .object({
    script: z.string().max(4000).optional().default(""),
    title: z.string().max(120).optional(),
    /** Sent verbatim as the final prompt — no course-style wrapping applied. */
    imagePrompt: z.string().max(8000).optional(),
    model: z.enum(IMAGE_MODEL_OPTIONS).default("nano-banana-2"),
    /** 16:9 matches COURSE_VISUAL_STYLE's landscape band layout. */
    aspectRatio: z.enum(IMAGE_ASPECT_OPTIONS).default("16:9"),
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

    // Deliberately NOT the md §3 wrapper: it forbids typography and asks for a
    // single illustration, but compose needs labelled cards it can crop and
    // animate one-by-one. COURSE_VISUAL_STYLE encodes that layout.
    const basePrompt = directPrompt || buildCompositeImagePrompt(script, title);
    if (!basePrompt) {
      throw new Error("Provide a custom image prompt or a script.");
    }

    // The house style is always applied — every scene must share one look.
    const referenceUrls = await houseStyleReferenceUrls();

    const imagePrompt = [basePrompt, styleLine(referenceUrls.length)]
      .filter(Boolean)
      .join("\n\n");

    const imageUrl = await generateReplicateImageDataUrl({
      model: data.model,
      prompt: imagePrompt,
      aspect: data.aspectRatio,
      referenceUrls,
    });
    return {
      imageUrl,
      title,
      imagePrompt,
      model: data.model,
      aspectRatio: data.aspectRatio,
      styleRefCount: referenceUrls.length,
      promptMode: directPrompt ? ("direct" as const) : ("auto" as const),
    };
  });
