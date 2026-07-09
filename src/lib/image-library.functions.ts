import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const AI_URL = "https://ai.gateway.lovable.dev/v1";

async function embed(prompt: string): Promise<number[]> {
  const key = process.env.LOVABLE_API_KEY!;
  const res = await fetch(`${AI_URL}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: prompt.slice(0, 2000),
    }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.data[0].embedding;
}

async function generateImage(prompt: string, kind: "background" | "element"): Promise<string> {
  const key = process.env.LOVABLE_API_KEY!;
  const styled =
    kind === "background"
      ? `Empty 16:9 widescreen hand-drawn Excalidraw-style whiteboard background. Very light pastel wash (soft cream, mint, sky-blue, or lavender), subtle dotted or faint grid texture, gentle vignette. NO foreground objects, NO characters, NO icons, NO text, NO arrows — background only. Wide landscape composition. Mood context: ${prompt}`
      : `A SINGLE isolated hand-drawn Excalidraw-style illustration of: ${prompt}.
Thick black sketch outlines, slightly imperfect hand-drawn shapes, pastel color fills, soft shadows. Playful, friendly, educational.
CRITICAL: subject centered on a PURE WHITE (#FFFFFF) background with generous padding on all sides. Absolutely no other elements, no background scenery, no text, no labels, no borders, no frame. Square framing. Just the subject on white.`;

  const res = await fetch(`${AI_URL}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-image",
      messages: [{ role: "user", content: styled }],
      modalities: ["image", "text"],
    }),
  });
  if (!res.ok) throw new Error(`Image failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image returned");
  return `data:image/png;base64,${b64}`;
}

const Input = z.object({
  prompt: z.string().min(1).max(1000),
  kind: z.enum(["background", "element"]),
});

/**
 * Semantic image cache. Embeds prompt, looks for a similar cached image;
 * if found, bumps usage and returns it. Otherwise generates + caches.
 * Requires auth so we can attribute created_by and enforce fair use.
 */
export const findOrGenerateImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const embedding = await embed(`${data.kind}: ${data.prompt}`);

    const threshold = data.kind === "background" ? 0.85 : 0.9;

    const { data: match, error: matchErr } = await supabase.rpc("match_image_asset", {
      query_embedding: embedding as any,
      match_kind: data.kind,
      match_threshold: threshold,
    });

    if (!matchErr && match && match.length > 0) {
      const hit = match[0];
      await supabase.rpc("bump_image_asset_usage", { asset_id: hit.id });
      return { dataUrl: hit.public_url, cached: true };
    }

    // Miss: generate + insert
    const dataUrl = await generateImage(data.prompt, data.kind);
    const { error: insErr } = await supabase.from("image_assets").insert({
      prompt: data.prompt,
      kind: data.kind,
      storage_path: "inline",
      public_url: dataUrl,
      embedding: embedding as any,
      created_by: userId,
    });
    if (insErr) console.warn("Failed to cache image asset:", insErr.message);
    return { dataUrl, cached: false };
  });
