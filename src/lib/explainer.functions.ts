import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AI_URL = "https://ai.gateway.lovable.dev/v1";
const ELEVEN_VOICE_ID = "TX3LPaxmHKxFdv7VOQHJ"; // Liam
const ELEVEN_MODEL = "eleven_v3";

// ---------- Types shared with client ----------
export type SceneKind = "image" | "stock" | "code";
export type CodeVariant = "typing" | "morph" | "scroll" | "flight";
export type ElementAnim = "pop" | "fade" | "slide-up" | "slide-left" | "slide-right";

export interface CompositionElement {
  id: string;
  prompt: string;
  /** center X, 0..1 across 16:9 canvas */
  x: number;
  /** center Y, 0..1 */
  y: number;
  /** width as fraction of canvas width, 0..1 */
  w: number;
  /** fraction of scene duration when element appears, 0..1 */
  appearAt: number;
  anim: ElementAnim;
}

export interface SceneComposition {
  backgroundPrompt: string;
  elements: CompositionElement[];
}

export interface ScenePlan {
  id: string;
  sentence: string;
  narrationText: string;
  subtitle: string;
  kind: SceneKind;
  composition?: SceneComposition; // for kind = "image"
  pexelsQuery?: string;
  code?: string;
  codeTo?: string;
  codeLanguage?: string;
  codeVariant?: CodeVariant;
  animation: "kenburns-in" | "kenburns-out" | "fade" | "slide-left";
}

// ---------- Plan + enhance a script ----------
const PlanInput = z.object({
  script: z.string().min(1).max(8000),
  preserveWords: z.boolean().optional(),
});

export const planScript = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => PlanInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const preserveWords = !!data.preserveWords;

    const intro = preserveWords
      ? `You are a video director editing a TRANSCRIBED voiceover into scenes.
The user gives you a raw transcript. Your job:

STEP 1 — Split the transcript into 4–40 short scene-sized sentences.
CRITICAL: Do NOT rewrite, paraphrase, add, drop, reorder, or translate any word.
The concatenation of sentence fields (in order) must equal the transcript
verbatim except for punctuation, casing, and whitespace. You may only ADD
punctuation and fix capitalization.`
      : `You are a video director + narration script editor for an explainer video.

STEP 1 — Enhance the script:
- Rewrite the user script for clarity, natural spoken cadence, and engagement.
- Keep the meaning and length roughly similar.
- Split into 4–14 short, punchy sentences (each 6–20 words).`;

    const narrationRule = preserveWords
      ? `- narrationText: set equal to sentence (unused — audio is provided).`
      : `- narrationText: same sentence enhanced for ElevenLabs v3 expressive TTS.
  Add inline audio tags in square brackets to shape delivery.
  Valid tags: [excited], [curious], [whispers], [laughs], [sighs],
  [thoughtful], [confident], [warm], [pauses], [emphasizes], [softly].
  Use 1–3 tags per sentence, placed BEFORE the words they modify.
  Use ellipses (…) and commas for pacing. Do NOT invent new tags.`;

    const sys = `${intro}

STEP 2 — For each sentence, produce a scene object:
- sentence: clean sentence (no audio tags, used for on-screen subtitle).
${narrationRule}
- kind: one of
    "code"  — sentence is about code, syntax, an API, a function, a file.
    "image" — abstract concepts, ideas, metaphors, workflows.
    "stock" — concrete real-world things (people, nature, cities, products).
- If kind = "image": composition object with:
    backgroundPrompt: describe an EMPTY 16:9 whiteboard background scene
      (soft pastel wash, subtle grid or dot texture, no foreground objects,
      no text). Sets the mood.
    elements: array of 2–5 items appearing one-by-one. Each element:
      id: short slug ("rocket","chart","user").
      prompt: single subject description (e.g. "a smiling cartoon rocket
        with flames"), NO style words — style is added later. NO text/labels.
      x: 0..1 center X on the canvas (0=left, 1=right).
      y: 0..1 center Y (0=top, 1=bottom).
      w: 0..1 width fraction (typical 0.18–0.35).
      appearAt: 0..1 fraction of the scene duration when this element
        appears. First element ~0.05, last element <= 0.75. Spread evenly.
      anim: one of "pop","fade","slide-up","slide-left","slide-right".
    IMPORTANT: distribute elements across the canvas — don't overlap.
    Use a mental grid: left/center/right, top/middle/bottom.
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

    const clamp = (v: any, lo: number, hi: number, dflt: number) => {
      const n = Number(v);
      if (!isFinite(n)) return dflt;
      return Math.max(lo, Math.min(hi, n));
    };

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

      let composition: SceneComposition | undefined;
      if (kind === "image") {
        const rawEls: any[] = Array.isArray(meta?.composition?.elements)
          ? meta.composition.elements
          : [];
        const validAnims: ElementAnim[] = [
          "pop",
          "fade",
          "slide-up",
          "slide-left",
          "slide-right",
        ];
        const elements: CompositionElement[] = rawEls
          .slice(0, 6)
          .map((el: any, ei: number) => ({
            id: String(el?.id ?? `el${ei}`).slice(0, 24),
            prompt: String(el?.prompt ?? sentence).slice(0, 200),
            x: clamp(el?.x, 0.05, 0.95, 0.2 + (ei * 0.6) / Math.max(1, rawEls.length - 1)),
            y: clamp(el?.y, 0.1, 0.9, 0.5),
            w: clamp(el?.w, 0.1, 0.5, 0.25),
            appearAt: clamp(el?.appearAt, 0, 0.85, (ei / Math.max(1, rawEls.length)) * 0.75),
            anim: validAnims.includes(el?.anim) ? el.anim : "pop",
          }));
        composition = {
          backgroundPrompt: String(
            meta?.composition?.backgroundPrompt ??
              `soft pastel whiteboard background for: ${sentence}`,
          ).slice(0, 300),
          elements: elements.length
            ? elements
            : [
                {
                  id: "main",
                  prompt: sentence,
                  x: 0.5,
                  y: 0.5,
                  w: 0.35,
                  appearAt: 0.05,
                  anim: "pop",
                },
              ],
        };
      }

      return {
        id: `s${i}`,
        sentence,
        narrationText,
        subtitle: String(meta?.subtitle ?? "").trim() || sentence.slice(0, 60),
        kind,
        composition,
        pexelsQuery:
          kind === "stock"
            ? String(meta?.pexelsQuery ?? sentence.split(" ").slice(0, 3).join(" "))
            : undefined,
        code:
          kind === "code"
            ? normalizeCode(meta?.code) ||
              `// ${sentence}\nconsole.log("example");`
            : undefined,
        codeTo:
          kind === "code" && codeVariant === "morph"
            ? normalizeCode(meta?.codeTo) || normalizeCode(meta?.code) || ""
            : undefined,
        codeLanguage: kind === "code" ? String(meta?.codeLanguage ?? "ts") : undefined,
        codeVariant: kind === "code" ? codeVariant : undefined,
        animation: animations[i % animations.length],
      };
    });

    return { scenes };
  });

// ---------- Generate one composited BACKGROUND (16:9, empty scene) ----------
const BgInput = z.object({ prompt: z.string().min(1) });

export const generateSceneBackground = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => BgInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const styled = `Empty 16:9 widescreen hand-drawn Excalidraw-style whiteboard background. Very light pastel wash (soft cream, mint, sky-blue, or lavender), subtle dotted or faint grid texture, gentle vignette. NO foreground objects, NO characters, NO icons, NO text, NO arrows — background only. Wide landscape composition. Mood context: ${data.prompt}`;

    const res = await fetch(`${AI_URL}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages: [{ role: "user", content: styled }],
        modalities: ["image", "text"],
      }),
    });
    if (!res.ok) throw new Error(`Background failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("No background image returned");
    return { dataUrl: `data:image/png;base64,${b64}` };
  });

// ---------- Generate a single ELEMENT (isolated on pure white, for multiply blend) ----------
const ElInput = z.object({ prompt: z.string().min(1) });

export const generateSceneElement = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => ElInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const styled = `A SINGLE isolated hand-drawn Excalidraw-style illustration of: ${data.prompt}.
Thick black sketch outlines, slightly imperfect hand-drawn shapes, pastel color fills, soft shadows. Playful, friendly, educational.
CRITICAL: subject centered on a PURE WHITE (#FFFFFF) background with generous padding on all sides. Absolutely no other elements, no background scenery, no text, no labels, no borders, no frame. Square framing. Just the subject on white.`;

    const res = await fetch(`${AI_URL}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages: [{ role: "user", content: styled }],
        modalities: ["image", "text"],
      }),
    });
    if (!res.ok) throw new Error(`Element failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("No element image returned");
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

    let res: Response | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 6; attempt++) {
      res = await fetch(
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
      if (res.ok) break;
      if (res.status !== 429 && res.status < 500) {
        lastErr = await res.text();
        throw new Error(`TTS failed: ${res.status} ${lastErr}`);
      }
      lastErr = await res.text();
      const delay = Math.min(8000, 800 * Math.pow(2, attempt)) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, delay));
    }
    if (!res || !res.ok) throw new Error(`TTS failed: ${res?.status ?? "?"} ${lastErr}`);
    const buf = await res.arrayBuffer();
    const b64 = Buffer.from(buf).toString("base64");
    return { audioUrl: `data:audio/mpeg;base64,${b64}` };
  });
