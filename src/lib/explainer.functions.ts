import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AI_URL = "https://ai.gateway.lovable.dev/v1";

// ---------- Types shared with client ----------
export type SceneKind = "image" | "stock";
export interface ScenePlan {
  id: string;
  sentence: string;
  subtitle: string;
  kind: SceneKind;
  imagePrompt?: string;
  pexelsQuery?: string;
  animation: "kenburns-in" | "kenburns-out" | "fade" | "slide-left";
}

// ---------- Plan a script ----------
function splitSentences(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const parts = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned];
  return parts.map((s) => s.trim()).filter(Boolean).slice(0, 40);
}

const PlanInput = z.object({ script: z.string().min(1).max(8000) });

export const planScript = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => PlanInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const sentences = splitSentences(data.script);
    if (sentences.length === 0) throw new Error("Empty script");

    const sys = `You are a video director. For each sentence in an explainer video script, decide:
- kind: "image" for abstract concepts, ideas, metaphors, or when no realistic footage would fit; "stock" for concrete real-world things (people, nature, cities, food, animals, tech products) that Pexels would have great footage of.
- imagePrompt (if image): a concise prompt for a flat, minimal illustration on pure white background, single subject, editorial style.
- pexelsQuery (if stock): 2-4 keywords for Pexels video search.
- subtitle: a short (<= 8 words) caption drawn from the sentence.
Return ONLY a JSON array with items {index, kind, imagePrompt?, pexelsQuery?, subtitle}. No prose.`;

    const user = sentences.map((s, i) => `${i}: ${s}`).join("\n");

    const res = await fetch(`${AI_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`Planner failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content ?? "[]";
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
    const arr: any[] = Array.isArray(parsed) ? parsed : parsed.scenes ?? parsed.items ?? [];

    const animations: ScenePlan["animation"][] = [
      "kenburns-in",
      "kenburns-out",
      "fade",
      "slide-left",
    ];

    const scenes: ScenePlan[] = sentences.map((sentence, i) => {
      const meta = arr.find((x) => x?.index === i) ?? arr[i] ?? {};
      const kind: SceneKind = meta.kind === "stock" ? "stock" : "image";
      return {
        id: `s${i}`,
        sentence,
        subtitle: (meta.subtitle as string) || sentence.slice(0, 60),
        kind,
        imagePrompt:
          kind === "image"
            ? (meta.imagePrompt as string) ||
              `Minimal flat illustration on pure white background: ${sentence}`
            : undefined,
        pexelsQuery:
          kind === "stock"
            ? (meta.pexelsQuery as string) || sentence.split(" ").slice(0, 3).join(" ")
            : undefined,
        animation: animations[i % animations.length],
      };
    });

    return { scenes };
  });

// ---------- Generate image (Gemini via gateway) ----------
const ImgInput = z.object({ prompt: z.string().min(1) });

export const generateSceneImage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => ImgInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const res = await fetch(`${AI_URL}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages: [
          {
            role: "user",
            content: `Flat minimal editorial illustration on a pure white background, single clear subject, soft muted colors, no text. Subject: ${data.prompt}`,
          },
        ],
        modalities: ["image", "text"],
      }),
    });
    if (!res.ok) throw new Error(`Image failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("No image returned");
    return { dataUrl: `data:image/png;base64,${b64}` };
  });

// ---------- Pexels stock video search ----------
const PexInput = z.object({ query: z.string().min(1) });

export const searchStockClip = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => PexInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.PEXELS_API_KEY;
    if (!key) throw new Error("PEXELS_API_KEY missing");

    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(
      data.query,
    )}&per_page=5&orientation=landscape`;
    const res = await fetch(url, { headers: { Authorization: key } });
    if (!res.ok) throw new Error(`Pexels failed: ${res.status}`);
    const json = await res.json();
    const video = json.videos?.[0];
    if (!video) return { videoUrl: null, posterUrl: null };
    // pick a file around 1280 wide, mp4
    const files: any[] = video.video_files ?? [];
    const preferred =
      files.find(
        (f) => f.file_type === "video/mp4" && f.width && f.width >= 960 && f.width <= 1600,
      ) ||
      files.find((f) => f.file_type === "video/mp4") ||
      files[0];
    return {
      videoUrl: preferred?.link ?? null,
      posterUrl: video.image ?? null,
    };
  });

// ---------- TTS (OpenAI via Lovable gateway) ----------
const TtsInput = z.object({ text: z.string().min(1).max(1500) });

export const generateNarration = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => TtsInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const res = await fetch(`${AI_URL}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini-tts",
        input: data.text,
        voice: "alloy",
        response_format: "mp3",
      }),
    });
    if (!res.ok) throw new Error(`TTS failed: ${res.status} ${await res.text()}`);
    const buf = await res.arrayBuffer();
    const b64 = Buffer.from(buf).toString("base64");
    return { audioUrl: `data:audio/mpeg;base64,${b64}` };
  });
