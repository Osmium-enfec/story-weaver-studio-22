import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AI_URL = "https://ai.gateway.lovable.dev/v1";
const ELEVEN_VOICE_ID = "TX3LPaxmHKxFdv7VOQHJ"; // Liam
const ELEVEN_MODEL = "eleven_v3";

// ---------- Types shared with client ----------
export type SceneKind = "image" | "stock" | "code";
export type CodeVariant = "typing" | "morph" | "scroll" | "flight";
export interface ScenePlan {
  id: string;
  sentence: string;
  narrationText: string;
  subtitle: string;
  kind: SceneKind;
  imagePrompt?: string;
  pexelsQuery?: string;
  code?: string;
  codeTo?: string;
  codeLanguage?: string;
  codeVariant?: CodeVariant;
  animation: "kenburns-in" | "kenburns-out" | "fade" | "slide-left";
}

// ---------- Plan + enhance a script ----------
const PlanInput = z.object({ script: z.string().min(1).max(8000) });

export const planScript = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => PlanInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const sys = `You are a video director + narration script editor for an explainer video.

STEP 1 — Enhance the script:
- Rewrite the user script for clarity, natural spoken cadence, and engagement.
- Keep the meaning and length roughly similar.
- Split into 4–14 short, punchy sentences (each 6–20 words).

STEP 2 — For each enhanced sentence, produce:
- sentence: clean sentence (no audio tags, used for on-screen subtitle).
- narrationText: same sentence enhanced for ElevenLabs v3 expressive TTS.
  Add inline audio tags in square brackets to shape delivery.
  Valid tags: [excited], [curious], [whispers], [laughs], [sighs],
  [thoughtful], [confident], [warm], [pauses], [emphasizes], [softly].
  Use 1–3 tags per sentence, placed BEFORE the words they modify.
  Use ellipses (…) and commas for pacing. Do NOT invent new tags.
- kind: one of
    "code"  — sentence is about code, syntax, an API, a function, a file.
    "image" — abstract concepts, ideas, metaphors, workflows.
    "stock" — concrete real-world things (people, nature, cities, products).
- If kind = "image": imagePrompt (short subject-only description, no style).
- If kind = "stock": pexelsQuery (2–4 keywords).
- If kind = "code":
    code: short realistic snippet (5–15 lines, real syntax, no backticks).
    codeLanguage: "ts" | "js" | "tsx" | "py" | "sh" | "json" | "html".
    codeVariant: one of
      "typing" (types out char by char — introducing new code),
      "morph"  (line-by-line diff to codeTo — comparing before/after),
      "scroll" (scrolls a long file — showing a whole module),
      "flight" (lines fly in from sides — punchy list-style code).
    codeTo: REQUIRED only for "morph".
- subtitle: <= 8 words drawn from the sentence.

Return ONLY strict JSON: { "scenes": [ ... ] }. No prose.`;

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
          { role: "user", content: data.script },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`Planner failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content ?? "{}";
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    const arr: any[] = Array.isArray(parsed) ? parsed : parsed.scenes ?? parsed.items ?? [];
    if (!arr.length) throw new Error("Planner returned no scenes");

    const animations: ScenePlan["animation"][] = [
      "kenburns-in",
      "kenburns-out",
      "fade",
      "slide-left",
    ];

    const scenes: ScenePlan[] = arr.slice(0, 40).map((meta: any, i: number) => {
      const rawKind = meta?.kind;
      const kind: SceneKind =
        rawKind === "code" ? "code" : rawKind === "stock" ? "stock" : "image";
      const sentence = String(meta?.sentence ?? "").trim() || `Scene ${i + 1}`;
      const narrationText = String(meta?.narrationText ?? "").trim() || sentence;
      const codeVariant: CodeVariant = ["typing", "morph", "scroll", "flight"].includes(
        meta?.codeVariant,
      )
        ? meta.codeVariant
        : "typing";
      return {
        id: `s${i}`,
        sentence,
        narrationText,
        subtitle: String(meta?.subtitle ?? "").trim() || sentence.slice(0, 60),
        kind,
        imagePrompt: kind === "image" ? String(meta?.imagePrompt ?? sentence) : undefined,
        pexelsQuery:
          kind === "stock"
            ? String(meta?.pexelsQuery ?? sentence.split(" ").slice(0, 3).join(" "))
            : undefined,
        code: kind === "code" ? String(meta?.code ?? "// code") : undefined,
        codeTo:
          kind === "code" && codeVariant === "morph"
            ? String(meta?.codeTo ?? meta?.code ?? "")
            : undefined,
        codeLanguage: kind === "code" ? String(meta?.codeLanguage ?? "ts") : undefined,
        codeVariant: kind === "code" ? codeVariant : undefined,
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
            content: `Create a hand-drawn Excalidraw-inspired whiteboard illustration in 16:9. Bright pure white background with a soft light-gray rounded frame. Thick black sketch outlines, slightly imperfect hand-drawn shapes, pastel color fills, soft shadows, friendly rounded typography. Spacious layout with clear separation between elements, no overlapping arrows or text. Use color highlights: blue for tech/code, green for success, purple for technical terms, orange for tools/actions, red only for warnings. Playful educational icons (laptops, chat bubbles, robots, toolboxes, folders, charts, checkmarks, light bulbs, stars, arrows) where relevant. Minimal, large, readable text labels only. Premium classroom-doodle mood, beginner-friendly, suitable for voiceover animation.\n\nSubject: ${data.prompt}`,
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

// ---------- TTS (ElevenLabs v3, Liam voice) ----------
const TtsInput = z.object({ text: z.string().min(1).max(2000) });

export const generateNarration = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => TtsInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("ELEVENLABS_API_KEY missing");

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: data.text,
          model_id: ELEVEN_MODEL,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.5,
            use_speaker_boost: true,
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`TTS failed: ${res.status} ${await res.text()}`);
    const buf = await res.arrayBuffer();
    const b64 = Buffer.from(buf).toString("base64");
    return { audioUrl: `data:audio/mpeg;base64,${b64}` };
  });
