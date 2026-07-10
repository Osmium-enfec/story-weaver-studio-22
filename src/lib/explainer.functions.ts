import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AI_URL = "https://ai.gateway.lovable.dev/v1";
const ELEVEN_VOICE_ID = "TX3LPaxmHKxFdv7VOQHJ"; // Liam
const ELEVEN_MODEL = "eleven_v3";

// ---------- Types shared with client ----------
export type SceneKind = "image" | "code";
export type CodeVariant = "typing" | "morph" | "scroll" | "flight";
export type ElementAnim = "pop" | "fade" | "slide-up" | "slide-left" | "slide-right";

export interface CompositionElement {
  id: string;
  prompt: string;
  /** Optional short hand-drawn label rendered UNDER the element by the player. */
  label?: string;
  /** center X, 0..1 across 16:9 canvas — assigned by layout grid, not the LLM. */
  x: number;
  /** center Y, 0..1 — assigned by layout grid, not the LLM. */
  y: number;
  /** width as fraction of canvas width, 0..1 — assigned by layout grid. */
  w: number;
  /** fraction of scene duration when element appears, 0..1 */
  appearAt: number;
  anim: ElementAnim;
}

export interface SceneComposition {
  backgroundPrompt: string;
  /** Hand-drawn topic title shown at the top of the scene (Excalidraw font). */
  title?: string;
  elements: CompositionElement[];
}

export interface ScenePlan {
  id: string;
  sentence: string;
  narrationText: string;
  subtitle: string;
  kind: SceneKind;
  composition?: SceneComposition; // for kind = "image"
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
    "image" — everything else. Use AI-generated illustrations, never stock footage.
- If kind = "image": composition object with:
    backgroundPrompt: short mood/setting description of the scene
      (e.g. "workflow diagram about data processing"). Used only to steer
      the background style — do NOT include text here.
    title: short hand-drawn TITLE (2-5 words) rendered by the player at the
      TOP of the scene in an Excalidraw-style handwritten font. REQUIRED for
      image scenes. Keep it a plain topic label, no punctuation.
    elements: array of 1–6 distinct visual items appearing one-by-one. Element
      positions are chosen automatically by a fixed grid layout — do NOT
      include x/y/w. Each element:
        id: short slug ("rocket","chart","user").
        prompt: single subject description (e.g. "a smiling cartoon rocket
          with flames"), NO style words — style is added later. NO text/labels.
        label: OPTIONAL short 1-3 word hand-drawn label rendered UNDER the
          element by the player (e.g. "read", "chunk", "embed").
        appearAt: 0..1 fraction of the scene duration when this element
          appears. First element ~0.05, last element <= 0.75. Spread evenly.
        anim: one of "pop","fade","slide-up","slide-left","slide-right".
    Prefer 2, 3, 4 or 6 elements — these map to the cleanest grid layouts
    (50/50, thirds, 2x2, 3x2). Use 1 only for a single hero illustration.
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
        max_tokens: 16000,
      }),
    });
    if (!res.ok) throw new Error(`Planner failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const raw: string = json.choices?.[0]?.message?.content ?? "";
    const finishReason = json.choices?.[0]?.finish_reason;
    console.log("[planner] finish_reason:", finishReason, "len:", raw.length, "usage:", json.usage);

    // Robust JSON extraction: strip markdown fences and try to close a
    // truncated JSON array so a MAX_TOKENS cut-off still yields scenes.
    const tryParse = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
    let parsed: any = tryParse(raw);
    if (!parsed) {
      let cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const start = cleaned.search(/[\{\[]/);
      if (start >= 0) cleaned = cleaned.slice(start);
      parsed = tryParse(cleaned);
      if (!parsed) {
        // Truncated? Cut back to the last complete `}` inside the scenes array
        // and close the array + object.
        const lastObj = cleaned.lastIndexOf("}");
        if (lastObj > 0) {
          const trimmed = cleaned.slice(0, lastObj + 1) + "]}";
          parsed = tryParse(trimmed);
        }
      }
      if (!parsed) {
        console.error("[planner] failed to parse raw output:", raw.slice(0, 800));
        parsed = {};
      }
    }

    let arr: any[] = Array.isArray(parsed) ? parsed : parsed.scenes ?? parsed.items ?? [];
    if (!arr.length) {
      console.warn("[planner] empty scenes — falling back to sentence split. finish:", finishReason);

      // Fallback: split the script into sentences and make one image scene each
      // so we never hard-fail on a bad planner response.
      const sentences = data.script
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      arr = (sentences.length ? sentences : [data.script.trim()]).map((s) => ({
        kind: "image",
        sentence: s,
        narrationText: s,
        durationMs: 3500,
        backgroundPrompt: s,
        elements: [],
        subtitle: s.split(" ").slice(0, 8).join(" "),
      }));
    }


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

    // Planner sometimes returns code as string[] or wrapped in ``` fences.
    const normalizeCode = (v: any): string => {
      let s = "";
      if (Array.isArray(v)) s = v.join("\n");
      else if (v == null) s = "";
      else s = String(v);
      s = s.replace(/^\s*```[a-zA-Z]*\n?/, "").replace(/\n?```\s*$/, "");
      return s.trim();
    };

    const scenes: ScenePlan[] = arr.slice(0, 40).map((meta: any, i: number) => {
      const rawKind = meta?.kind;
      // Only "image" and "code" now — legacy "stock" plans fall back to image.
      const kind: SceneKind = rawKind === "code" ? "code" : "image";
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
        // x/y/w are overridden by the grid layout on the client, but we still
        // fill them so the type stays satisfied and legacy consumers work.
        const elements: CompositionElement[] = rawEls
          .slice(0, 6)
          .map((el: any, ei: number) => ({
            id: String(el?.id ?? `el${ei}`).slice(0, 24),
            prompt: String(el?.prompt ?? sentence).slice(0, 200),
            label: el?.label ? String(el.label).slice(0, 40) : undefined,
            x: 0.5,
            y: 0.55,
            w: 0.22,
            appearAt: clamp(el?.appearAt, 0, 0.85, (ei / Math.max(1, rawEls.length)) * 0.75),
            anim: validAnims.includes(el?.anim) ? el.anim : "pop",
          }));
        composition = {
          backgroundPrompt: String(
            meta?.composition?.backgroundPrompt ??
              `soft pastel whiteboard background for: ${sentence}`,
          ).slice(0, 300),
          title: meta?.composition?.title
            ? String(meta.composition.title).slice(0, 60)
            : sentence.split(/\s+/).slice(0, 4).join(" "),
          elements: elements.length
            ? elements
            : [
                {
                  id: "main",
                  prompt: sentence,
                  x: 0.5,
                  y: 0.55,
                  w: 0.3,
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
            // Trailing ellipsis gives ElevenLabs a natural ~600ms tail pause
            // so the next scene doesn't start abruptly on top of speech.
            text: data.text.replace(/[.!?…]*\s*$/, "") + " ... ",
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
