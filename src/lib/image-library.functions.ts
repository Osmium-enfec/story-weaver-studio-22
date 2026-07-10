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

  let styled: string;
  if (kind === "element") {
    styled = `A SINGLE isolated hand-drawn Excalidraw-style illustration of: ${prompt}.
Thick black sketchy outlines (slightly wobbly, hand-drawn feel), pastel color fills (soft blues, greens, yellows, pinks, purples), subtle cross-hatch shading, gentle drop shadow. Friendly, cheerful, educational infographic character.
CRITICAL: subject centered on a PURE WHITE (#FFFFFF) background with generous padding on all sides. Absolutely no other elements, no background scenery, no text, no labels, no borders, no frame. Square framing. Just the subject on white.`;
  } else {
    // Parse baked-in directives from the composite prompt built in the client.
    const titleMatch = prompt.match(/TITLE_PILL:\{color:([a-z]+);text:"([^"]+)"\}/);
    const flowMatch = prompt.match(/FLOW:([^|]+)/);
    const footerMatch = prompt.match(/FOOTER_ROBOT:"([^"]+)"/);
    const moodPrompt = prompt.split("|")[0].trim();

    const title = titleMatch?.[2];
    const titleColor = titleMatch?.[1] ?? "blue";
    const flow = flowMatch?.[1]?.trim().split(/\s*->\s*/).filter(Boolean) ?? [];
    const footer = footerMatch?.[1];

    const titleLine = title
      ? `At the TOP CENTER, draw the title "${title}" in large hand-drawn black marker font, enclosed in a rounded rectangle "pill" filled with soft PASTEL ${titleColor.toUpperCase()}, with a thick black sketchy outline. Add small hand-drawn decorative marks (little lines/sparkles) on either side of the pill.`
      : `Leave the top area empty and clean.`;
    const flowLine =
      flow.length >= 2
        ? `DIRECTLY BELOW the title pill, draw a small hand-drawn horizontal arrow flow: ${flow
            .map((s) => `"${s}"`)
            .join(" → ")}. Use thin gray hand-drawn text separated by little curved arrows.`
        : "";
    const footerLine = footer
      ? `At the BOTTOM CENTER, draw a wide rounded rectangle "pill" filled with soft PASTEL LAVENDER/PURPLE, with a thick black sketchy outline. Inside the pill, on the LEFT, draw a small cute cartoon robot with a smiling face (rounded body, antenna, one small screen face). To the right of the robot, write the message "${footer}" in hand-drawn black marker font. Add a small hand-drawn pencil doodle at the far right of the pill.`
      : `Leave the bottom area empty and clean.`;

    styled = `A hand-drawn Excalidraw-style whiteboard INFOGRAPHIC background, 16:9 widescreen. Off-white paper background with a very subtle warm cream tint. All strokes are thick, slightly wobbly hand-drawn black marker lines. Overall look matches these references: colorful pastel pill labels, sketched arrow flow, cute robot mascot footer message.

${titleLine}

${flowLine}

The LARGE CENTER AREA (roughly 70% of the canvas height) MUST be COMPLETELY EMPTY — pure clean off-white paper with no drawings, no icons, no shapes, no lines. This empty area will be filled with separate illustrations later. Do NOT draw anything in the middle of the canvas.

${footerLine}

Mood context (do not draw literally): ${moodPrompt}.

Style: educational infographic, playful, cheerful, hand-drawn, high-quality Excalidraw sketch. No photorealism. No stock icons. Consistent pastel palette. Only draw the title pill at the top, optional arrow flow just under it, and optional robot pill at the bottom — nothing else.`;
  }

  function extractB64(j: any): string | null {
    // Normalized OpenAI-images shape
    const direct = j?.data?.[0]?.b64_json;
    if (direct) return direct;
    // OpenRouter chat-completions image shape (fallback if not normalized)
    const choice = j?.choices?.[0]?.message;
    const imgs = choice?.images;
    if (Array.isArray(imgs) && imgs.length > 0) {
      const url = imgs[0]?.image_url?.url ?? imgs[0]?.url;
      if (typeof url === "string" && url.startsWith("data:image")) {
        return url.split(",")[1] ?? null;
      }
    }
    return null;
  }

  async function attempt(): Promise<{ b64: string | null; text: string; status: number }> {
    const res = await fetch(`${AI_URL}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages: [{ role: "user", content: styled }],
        modalities: ["image", "text"],
      }),
    });
    const text = await res.text();
    if (!res.ok) return { b64: null, text, status: res.status };
    let j: any = null;
    try { j = JSON.parse(text); } catch { return { b64: null, text, status: res.status }; }
    return { b64: extractB64(j), text, status: res.status };
  }

  let last = await attempt();
  if (!last.b64 && last.status < 400) {
    // Model sometimes returns only text; one retry usually succeeds.
    await new Promise((r) => setTimeout(r, 400));
    last = await attempt();
  }
  if (!last.b64) {
    throw new Error(
      last.status >= 400
        ? `Image failed: ${last.status} ${last.text.slice(0, 300)}`
        : `Image model returned no image (${last.text.slice(0, 300)})`,
    );
  }
  return `data:image/png;base64,${last.b64}`;
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
