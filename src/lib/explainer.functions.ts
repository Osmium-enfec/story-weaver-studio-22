import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AI_URL = "https://ai.gateway.lovable.dev/v1";
const REPLICATE_GATEWAY = "https://connector-gateway.lovable.dev/replicate/v1";
const ELEVEN_VOICE_ID = "TX3LPaxmHKxFdv7VOQHJ"; // Liam
const ELEVEN_MODEL = "eleven_v3";

// ---------- Types shared with client ----------
export type SceneKind = "image" | "code";
export type CodeVariant = "typing" | "morph" | "scroll" | "flight";
export type ElementAnim = "pop" | "fade" | "slide-up" | "slide-left" | "slide-right";

export interface CompositionElement {
  id: string;
  /** Legacy per-element image prompt (unused in composite mode). */
  prompt?: string;
  /** Text prompt used by Grounding-DINO/SAM to segment this element out of the composite. */
  segmentPrompt?: string;
  /** Optional short hand-drawn label rendered UNDER the element by the player. */
  label?: string;
  /** center X, 0..1 across canvas — from segmentation bbox when available, else grid layout. */
  x: number;
  y: number;
  w: number;
  /** Normalized bbox (0..1) of this element inside the composite image. Set after segmentation. */
  bbox?: { x: number; y: number; w: number; h: number };
  /** fraction of scene duration when element appears, 0..1 */
  appearAt: number;
  anim: ElementAnim;
}

export interface SceneComposition {
  /** ONE detailed Excalidraw prompt for the whole scene composite (arrows, boxes, characters). */
  compositePrompt?: string;
  /** Legacy: mood-only background prompt. Kept for backward compat with cached plans. */
  backgroundPrompt?: string;
  /** Hand-drawn topic title shown at the top of the scene (Excalidraw font). */
  title?: string;
  elements: CompositionElement[];
}

export interface ScenePlan {
  id: string;
  /** Full narrated text for the scene (may span 1–3 grouped sentences). */
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

// Parse manual scene markers like:
//   [scene 1 - AI Image] Every day, billions...
//   [scene2 - Code Typing] const x = 1;
// Type tokens supported (case-insensitive):
//   "ai image" | "image" -> kind=image
//   "code typing" | "code morph" | "code scroll" | "code flight" | "code" -> kind=code + variant
type ManualScene = {
  kind: SceneKind;
  codeVariant?: CodeVariant;
  text: string;
};
function parseManualScenes(script: string): ManualScene[] | null {
  const re = /\[\s*scene\s*\d+\s*[-–—:]\s*([^\]]+?)\s*\]/gi;
  const matches: { idx: number; len: number; typeRaw: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    matches.push({ idx: m.index, len: m[0].length, typeRaw: m[1] });
  }
  if (matches.length === 0) return null;
  const scenes: ManualScene[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const text = script.slice(cur.idx + cur.len, next ? next.idx : script.length).trim();
    if (!text) continue;
    const t = cur.typeRaw.toLowerCase().replace(/\s+/g, " ").trim();
    let kind: SceneKind = "image";
    let codeVariant: CodeVariant | undefined;
    if (t.startsWith("code")) {
      kind = "code";
      if (t.includes("morph")) codeVariant = "morph";
      else if (t.includes("scroll")) codeVariant = "scroll";
      else if (t.includes("flight")) codeVariant = "flight";
      else codeVariant = "typing";
    }
    scenes.push({ kind, codeVariant, text });
  }
  return scenes.length ? scenes : null;
}

export const planScript = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => PlanInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const preserveWords = !!data.preserveWords;
    const manual = parseManualScenes(data.script);

    const intro = manual
      ? `You are a video director. The user has ALREADY split the script into fixed
scenes and tagged each scene's TYPE. You MUST NOT re-chunk, merge, split, add,
or remove scenes. You MUST NOT change the sentence text of any scene (only add
punctuation / fix casing). You MUST use the tagged kind for each scene.

You will receive a JSON array \`inputScenes\`, one entry per scene, in order.
Return exactly the same number of scenes, in the same order, enriched with
composition/code metadata as described below.`
      : preserveWords
      ? `You are a video director editing a TRANSCRIBED voiceover into scenes.
The user gives you a raw transcript. Your job:

STEP 1 — Group the transcript into SCENES. Each scene contains 1–3 consecutive
sentences that describe the SAME idea and can share one whiteboard illustration.
Do NOT split a single explanatory beat across scenes. Aim for 3–12 scenes total
depending on script length, roughly 6–20 seconds of narration per scene.

CRITICAL: Do NOT rewrite, paraphrase, add, drop, reorder, or translate any word.
The concatenation of the sentence fields (in order) must equal the transcript
verbatim except for punctuation, casing, and whitespace. You may only ADD
punctuation and fix capitalization.`
      : `You are a video director + narration script editor for an explainer video
(usually short educational course content).

STEP 1 — Enhance and CHUNK the script:
- Rewrite for clarity, natural spoken cadence, and engagement (keep meaning).
- Group ideas into 3–10 SCENES. Each scene is 1–3 sentences that describe the
  SAME idea and can share ONE whiteboard illustration. Do NOT create a new
  scene per sentence — think in terms of "what fits on one whiteboard".
- Each scene should be roughly 6–20 seconds of narration.`;

    const narrationRule = manual || preserveWords
      ? `- narrationText: set equal to sentence (unused when audio is provided).`
      : `- narrationText: same as sentence but enhanced for ElevenLabs v3 expressive TTS.
  Add inline audio tags in square brackets to shape delivery.
  Valid tags: [excited], [curious], [whispers], [laughs], [sighs],
  [thoughtful], [confident], [warm], [pauses], [emphasizes], [softly].
  Use 1–3 tags per scene. Use ellipses (…) and commas for pacing. Do NOT invent new tags.`;

    const kindRule = manual
      ? `- kind: MUST equal the "kind" value provided in the matching inputScenes entry.
- For code scenes, MUST use the provided "codeVariant" if present.`
      : `- kind: one of
    "code"  — ONLY when the scene explicitly discusses source code, syntax,
      a specific function/file/command, or a code snippet the viewer should read.
    "image" — the default for narrative, marketing, explanatory content.
      Use ONE Excalidraw-style whiteboard drawing that captures the WHOLE scene
      (multiple sentences), with characters, boxes, arrows, and hand-lettered
      labels all drawn together — like a teacher sketching on a whiteboard.`;

    const sys = `${intro}

STEP 2 — For each SCENE, produce a scene object:
- sentence: the full text of the scene (all grouped sentences joined by a space).
${narrationRule}
${kindRule}
- If kind = "image": composition object with:
    compositePrompt: ONE rich prompt (60–200 words) describing the ENTIRE
      whiteboard illustration for this scene. Include:
        * the characters/objects/icons to draw (be specific — "a small dog",
          "a laptop", "a magnifying glass"),
        * their spatial arrangement (left, center, right, above, below),
        * any BOXES/CONTAINERS around them,
        * any ARROWS connecting them (with direction),
        * any hand-lettered LABEL text inside/next to elements.
      This should read like directions to an illustrator drawing one poster.
    title: short hand-drawn TITLE (2-5 words) rendered at the TOP by the player.
    elements: array of 2–6 REVEAL steps. Each step is one distinct visual piece
      in the composite that should FADE IN one-by-one as narration reaches it.
      Each element:
        id: short slug ("dog","arrow-1","box-input").
        segmentPrompt: 1–4 word noun phrase describing THIS element as it
          appears in the composite — fed to a text-prompted object detector
          to locate it. Examples: "the dog", "the red arrow", "the laptop".
        prompt: 8–25 word rich description of THIS element as a standalone
          hand-drawn illustration to be regenerated fresh in the same
          Excalidraw/watercolor style. Include the object, its pose, colors,
          and any small details.
        label: OPTIONAL short 1-3 word hand-drawn label rendered UNDER the
          element by the player (e.g. "input", "search", "answer").
        appearAt: 0..1 fraction of the scene duration when this element
          appears. First element ~0.05, last element <= 0.80. Spread evenly.
        anim: one of "pop","fade","slide-up","slide-left","slide-right".

- If kind = "code":
    code: short realistic snippet (5–15 lines, real syntax, no backticks).
    codeLanguage: "ts" | "js" | "tsx" | "py" | "sh" | "json" | "html".
    codeVariant: "typing" | "morph" | "scroll" | "flight".
    codeTo: REQUIRED only for "morph".
- subtitle: <= 8 words summarizing the scene.

Return ONLY strict JSON: { "scenes": [ ... ] }. No prose.`;

    const userMessage = manual
      ? `inputScenes = ${JSON.stringify(
          manual.map((s, i) => ({
            index: i,
            kind: s.kind,
            codeVariant: s.codeVariant,
            sentence: s.text,
          })),
        )}`
      : data.script;

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
          { role: "user", content: userMessage },
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

    const tryParse = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
    let parsed: any = tryParse(raw);
    if (!parsed) {
      let cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const start = cleaned.search(/[\{\[]/);
      if (start >= 0) cleaned = cleaned.slice(start);
      parsed = tryParse(cleaned);
      if (!parsed) {
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

    // If user tagged scenes manually, force the array to match the manual list
    // exactly (count, order, sentence, kind, codeVariant) and only borrow
    // enrichment fields (composition/code/subtitle) from the LLM per index.
    if (manual) {
      arr = manual.map((ms, i) => {
        const llmMeta = arr[i] ?? {};
        return {
          ...llmMeta,
          sentence: ms.text,
          narrationText: ms.text,
          kind: ms.kind,
          codeVariant: ms.kind === "code" ? (ms.codeVariant ?? "typing") : llmMeta.codeVariant,
        };
      });
    } else if (!arr.length) {
      console.warn("[planner] empty scenes — falling back to sentence split.");
      const sentences = data.script
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const groups: string[] = [];
      for (let i = 0; i < sentences.length; i += 2) {
        groups.push(sentences.slice(i, i + 2).join(" "));
      }
      arr = (groups.length ? groups : [data.script.trim()]).map((s) => ({
        kind: "image",
        sentence: s,
        narrationText: s,
        composition: {
          compositePrompt: `A hand-drawn whiteboard illustration about: ${s}`,
          title: s.split(/\s+/).slice(0, 4).join(" "),
          elements: [],
        },
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

    const normalizeCode = (v: any): string => {
      let s = "";
      if (Array.isArray(v)) s = v.join("\n");
      else if (v == null) s = "";
      else s = String(v);
      s = s.replace(/^\s*```[a-zA-Z]*\n?/, "").replace(/\n?```\s*$/, "");
      return s.trim();
    };

    const CODE_HINT_RE = /`|\bfunction\b|\bconst\b|\bimport\b|\bclass\b|\breturn\b|\bAPI\b|\bfile\b|\bcommand\b|\bsyntax\b|\bfunction\(|=>|;|\{|\}|\(\)/;
    const scenes: ScenePlan[] = arr.slice(0, 40).map((meta: any, i: number) => {
      const rawKind = meta?.kind;
      const sentence = String(meta?.sentence ?? "").trim() || `Scene ${i + 1}`;
      const narrationText = String(meta?.narrationText ?? "").trim() || sentence;
      const providedCode = normalizeCode(meta?.code);
      const looksLikeCode =
        CODE_HINT_RE.test(sentence) ||
        (providedCode.length > 20 && /[{};=()]/.test(providedCode));
      const kind: SceneKind = rawKind === "code" && (manual || looksLikeCode) ? "code" : "image";
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
          .map((el: any, ei: number) => {
            const segmentPrompt = String(
              el?.segmentPrompt ?? el?.prompt ?? el?.label ?? `element ${ei + 1}`,
            ).slice(0, 120);
            const prompt = String(el?.prompt ?? el?.segmentPrompt ?? el?.label ?? `hand-drawn illustration of ${segmentPrompt}`).slice(0, 400);
            return {
              id: String(el?.id ?? `el${ei}`).slice(0, 24),
              segmentPrompt,
              prompt,
              label: el?.label ? String(el.label).slice(0, 40) : undefined,
              x: 0.5,
              y: 0.55,
              w: 0.22,
              appearAt: clamp(el?.appearAt, 0, 0.85, (ei / Math.max(1, rawEls.length)) * 0.75),
              anim: validAnims.includes(el?.anim) ? el.anim : "pop",
            };
          });

        composition = {
          compositePrompt: String(
            meta?.composition?.compositePrompt ??
              meta?.composition?.backgroundPrompt ??
              `A hand-drawn whiteboard illustration about: ${sentence}`,
          ).slice(0, 1500),
          title: meta?.composition?.title
            ? String(meta.composition.title).slice(0, 60)
            : sentence.split(/\s+/).slice(0, 4).join(" "),
          elements: elements.length
            ? elements
            : [
                {
                  id: "main",
                  segmentPrompt: sentence.split(/\s+/).slice(0, 3).join(" "),
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

// ---------- Generate ONE composite Excalidraw image + discover elements via GPT-4o vision ----------
const CompositeInput = z.object({
  compositePrompt: z.string().min(1).max(2000),
  title: z.string().optional(),
  // Optional hint list from the planner. Ignored by the vision analyzer — kept
  // for backwards compat with older callers.
  elements: z
    .array(
      z.object({
        id: z.string(),
        segmentPrompt: z.string().min(1).max(120),
      }),
    )
    .optional(),
});

/**
 * Send the composite to GPT-4o vision and ask it to list every distinct
 * visual element it can see, with a normalized bbox and a rich hand-drawn
 * regeneration prompt for each. Replaces Grounding-DINO detection.
 */
async function analyzeCompositeWithVision(
  compositeDataUrl: string,
  compositePrompt: string,
): Promise<Array<{ id: string; label: string; prompt: string; bbox: { x: number; y: number; w: number; h: number } }>> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");

  const sys = `You are a vision analyst for a whiteboard-style explainer video.
You will receive ONE hand-drawn Excalidraw-style composite illustration.
Your job: list EVERY distinct visual element in it — characters, objects,
icons, arrows, boxes, hand-lettered labels, footers — so each can be
regenerated as its own transparent PNG and placed back at the exact same
spot on a fresh white canvas.

For EACH element return:
  id:     short slug ("dog","arrow-1","title-pill","robot-footer")
  label:  1-4 word noun phrase describing what it is
  prompt: 15-30 word rich standalone prompt to REDRAW this element alone,
          in the SAME Excalidraw style, on pure white. Include colors,
          pose, and any text lettering that is inside it.
  bbox:   [x, y, w, h] normalized to 0..1 of the full image (top-left origin).
          Tight around the element. Do NOT include big whitespace padding.

Rules:
- 3 to 8 elements. Merge tiny sub-parts into their parent.
- Do NOT return the whole-image background as an element.
- Order elements left-to-right, top-to-bottom (reading order).
- Return ONLY JSON: { "elements": [...] }. No prose.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        {
          role: "user",
          content: [
            { type: "text", text: `Composite context (what was requested):\n${compositePrompt}\n\nAnalyze the image and list its elements.` },
            { type: "image_url", image_url: { url: compositeDataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Vision analyze failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const raw = j?.choices?.[0]?.message?.content ?? "{}";
  let parsed: any = {};
  try { parsed = JSON.parse(raw); } catch { console.warn("[vision] parse fail:", raw.slice(0, 300)); }
  const arr: any[] = Array.isArray(parsed?.elements) ? parsed.elements : Array.isArray(parsed) ? parsed : [];
  const out: Array<{ id: string; label: string; prompt: string; bbox: { x: number; y: number; w: number; h: number } }> = [];
  arr.slice(0, 10).forEach((el, i) => {
    const bb = Array.isArray(el?.bbox) ? el.bbox.map(Number) : null;
    if (!bb || bb.length < 4 || bb.some((n: any) => !isFinite(n))) return;
    let [x, y, w, h] = bb;
    const maxV = Math.max(Math.abs(x), Math.abs(y), Math.abs(w), Math.abs(h), Math.abs(x + w), Math.abs(y + h));
    if (maxV > 1.5) {
      const div = maxV > 100 ? 1000 : maxV;
      x /= div; y /= div; w /= div; h /= div;
    }
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    w = Math.max(0.02, Math.min(1 - x, w));
    h = Math.max(0.02, Math.min(1 - y, h));
    const label = String(el?.label ?? `element ${i + 1}`).slice(0, 60);
    out.push({
      id: String(el?.id ?? `el${i}`).slice(0, 24),
      label,
      prompt: String(el?.prompt ?? `hand-drawn illustration of ${label}`).slice(0, 400),
      bbox: { x, y, w, h },
    });
  });
  return out;
}

async function generateCompositeImage(prompt: string, title?: string): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");

  const styled = `A clean 16:9 widescreen Excalidraw-style EDUCATIONAL INFOGRAPHIC on a PURE WHITE (#FFFFFF) background, suitable for a Python-for-AI course with voiceover.

STYLE (must match exactly):
- Hand-drawn slightly wobbly BLACK marker outlines (2–5px), rounded corners, occasional double strokes — sketchy but confident.
- FLAT PASTEL fills only (no watercolor, no cross-hatching, no gradients, no 3D, no photorealism):
  blue #3B82F6 / #DBEAFE (Python / main titles),
  green #22C55E / #DCFCE7 (correct / success),
  red #EF4444 / #FEE2E2 (wrong / errors),
  purple #8B5CF6 / #EDE9FE (technical concepts),
  orange/yellow #F59E0B / #FEF3C7 (hints).
- Rounded cards / pill shapes with sketchy outlines to group ideas.
- Playful doodle icons only (check, X, lock, star, lightbulb, snake, robot, laptop, file, folder, speech bubble, code window, tag, magnifier).
- Handwritten marker-style font for ALL text. Large, readable. Short phrases only.
- Minimal and spacious: generous white space everywhere. NO overlapping arrows, text, icons, or cards. One idea per element.
- Friendly, classroom-slide feel — like a modern teacher's whiteboard sketch.

SCENE TO DRAW: ${prompt}

${title ? `At the TOP CENTER, draw the title "${title}" in large handwritten marker-style black text inside a rounded rectangle "pill" with a sketchy black outline and a flat pastel BLUE (#DBEAFE) fill.` : ""}

CRITICAL RULES:
- SINGLE composed illustration — all elements laid out spatially with generous whitespace between them.
- Background must be PURE WHITE (#FFFFFF) EVERYWHERE — no cream, no off-white, no paper texture, no full-canvas colored panels.
- NO photorealism, NO watercolor, NO cross-hatching, NO drop shadows, NO scenery beyond what the scene calls for.
- Widescreen 16:9, generous margins on all edges.`;

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: styled,
      size: "1536x1024",
      n: 1,
      quality: "high",
      background: "auto",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI composite failed: ${res.status} ${text.slice(0, 400)}`);
  let j: any;
  try { j = JSON.parse(text); } catch {
    throw new Error(`OpenAI composite parse failed: ${text.slice(0, 300)}`);
  }
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI composite returned no data: ${text.slice(0, 300)}`);
  return `data:image/png;base64,${b64}`;
}

/**
 * Upload a data-URL image to Replicate /v1/files and return the public URL
 * that Replicate models can read.
 */
async function uploadToReplicate(dataUrl: string): Promise<string> {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const replicateKey = process.env.REPLICATE_API_KEY;
  if (!lovableKey || !replicateKey) throw new Error("Replicate connector env vars missing");

  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("uploadToReplicate: expected data URL");
  const mime = m[1];
  const bytes = Buffer.from(m[2], "base64");

  const form = new FormData();
  form.append("content", new Blob([bytes], { type: mime }), "composite.png");

  const res = await fetch(`${REPLICATE_GATEWAY}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": replicateKey,
    },
    body: form,
  });
  if (!res.ok) throw new Error(`Replicate upload failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  const url = j?.urls?.get;
  if (!url) throw new Error("Replicate upload returned no url");
  return url as string;
}

/**
 * Look up the latest version id for a community model (cached in-memory).
 */
const versionCache = new Map<string, string>();
async function getModelVersion(owner: string, name: string): Promise<string> {
  const key = `${owner}/${name}`;
  const cached = versionCache.get(key);
  if (cached) return cached;
  const lovableKey = process.env.LOVABLE_API_KEY!;
  const replicateKey = process.env.REPLICATE_API_KEY!;
  const res = await fetch(`${REPLICATE_GATEWAY}/models/${owner}/${name}`, {
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": replicateKey,
    },
  });
  if (!res.ok) throw new Error(`Model lookup failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  const version = j?.latest_version?.id;
  if (!version) throw new Error(`No latest_version for ${key}`);
  versionCache.set(key, version);
  return version;
}

/**
 * Run adirik/grounding-dino on Replicate to detect a set of labels in an image.
 * Returns a list of detections with normalized (0..1) bboxes.
 */
async function detectWithGroundingDino(
  imageUrl: string,
  labels: string[],
): Promise<Array<{ label: string; bbox: { x: number; y: number; w: number; h: number }; confidence: number }>> {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const replicateKey = process.env.REPLICATE_API_KEY;
  if (!lovableKey || !replicateKey) throw new Error("Replicate connector env vars missing");

  // adirik/grounding-dino accepts labels separated by " . " (period+space).
  const query = labels.join(" . ");

  const version = await getModelVersion("adirik", "grounding-dino");

  // Retry on 429 (rate limit — low-credit accounts are capped at 6 rpm).
  let createRes: Response | null = null;
  let lastBody = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    createRes = await fetch(`${REPLICATE_GATEWAY}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": replicateKey,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({
        version,
        input: {
          image: imageUrl,
          query,
          box_threshold: 0.25,
          text_threshold: 0.2,
          show_visualisation: false,
        },
      }),
    });
    if (createRes.ok || (createRes.status < 500 && createRes.status !== 429)) break;
    lastBody = await createRes.text();
    // Respect retry_after when present, else exponential backoff.
    let waitMs = 2000 * Math.pow(2, attempt);
    try {
      const j = JSON.parse(lastBody);
      if (j?.retry_after) waitMs = Number(j.retry_after) * 1000 + 500;
    } catch {}
    console.warn(`[grounding-dino] ${createRes.status} — retrying in ${waitMs}ms (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, Math.min(15000, waitMs)));
  }
  if (!createRes) throw new Error("GroundingDINO: no response");
  if (createRes.status === 402) {
    throw new Error("Replicate account has no credit. Enable billing at https://replicate.com/account/billing.");
  }
  if (!createRes.ok) {
    throw new Error(`GroundingDINO create failed: ${createRes.status} ${lastBody || (await createRes.text())}`);
  }
  let pred = await createRes.json();

  // Poll if still running.
  for (let i = 0; i < 60 && (pred.status === "starting" || pred.status === "processing"); i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 1500 : 3000));
    const pollRes = await fetch(`${REPLICATE_GATEWAY}/predictions/${pred.id}`, {
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": replicateKey,
      },
    });
    if (!pollRes.ok) throw new Error(`GroundingDINO poll failed: ${pollRes.status}`);
    pred = await pollRes.json();
  }

  if (pred.status !== "succeeded") {
    throw new Error(`GroundingDINO failed: ${pred.status} ${JSON.stringify(pred.error || pred).slice(0, 300)}`);
  }

  const output = pred.output;
  // Output shape (adirik/grounding-dino): { detections: [{ label, bbox: [x1,y1,x2,y2], confidence }], image_width, image_height }
  let detections: any[] = [];
  let imgW = 0, imgH = 0;
  if (Array.isArray(output)) {
    detections = output;
  } else if (output && typeof output === "object") {
    detections = output.detections || output.result || output.predictions || [];
    imgW = Number(output.image_width || output.width || 0);
    imgH = Number(output.image_height || output.height || 0);
  }

  console.log("[grounding-dino] labels:", labels, "detections:", detections.length, "imgW:", imgW);

  const results: Array<{ label: string; bbox: { x: number; y: number; w: number; h: number }; confidence: number }> = [];
  for (const d of detections) {
    const rawLabel = String(d.label || d.class || d.name || "").trim();
    let bbox = d.bbox || d.box || d.bounding_box;
    if (!Array.isArray(bbox) || bbox.length < 4) continue;
    let [x1, y1, x2, y2] = bbox.map(Number);
    // If values look like pixels (>1) and we know image dimensions, normalize.
    const looksPixel = Math.max(x1, y1, x2, y2) > 1.5;
    if (looksPixel && imgW && imgH) {
      x1 /= imgW; x2 /= imgW; y1 /= imgH; y2 /= imgH;
    } else if (looksPixel) {
      // Unknown dims: fall back to 1536x1024 (our composite size).
      x1 /= 1536; x2 /= 1536; y1 /= 1024; y2 /= 1024;
    }
    const nx = Math.max(0, Math.min(1, Math.min(x1, x2)));
    const ny = Math.max(0, Math.min(1, Math.min(y1, y2)));
    const nw = Math.max(0, Math.min(1 - nx, Math.abs(x2 - x1)));
    const nh = Math.max(0, Math.min(1 - ny, Math.abs(y2 - y1)));
    if (nw < 0.02 || nh < 0.02) continue;
    results.push({
      label: rawLabel,
      bbox: { x: nx, y: ny, w: nw, h: nh },
      confidence: Number(d.confidence || d.score || 0),
    });
  }
  return results;
}

/**
 * Fuzzy-match a detection back to the segmentPrompt the LLM asked for.
 * Grounding-DINO may return partial matches ("dog" vs "the small dog").
 */
function matchDetection(
  segmentPrompt: string,
  detections: Array<{ label: string; bbox: any; confidence: number }>,
  used: Set<number>,
): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const wanted = norm(segmentPrompt);
  const wantedTokens = wanted.split(" ").filter((t) => t.length > 2 && !["the", "and"].includes(t));

  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < detections.length; i++) {
    if (used.has(i)) continue;
    const cand = norm(detections[i].label);
    let score = 0;
    if (cand === wanted) score += 100;
    for (const tok of wantedTokens) {
      if (cand.includes(tok)) score += 10;
    }
    score += detections[i].confidence * 5;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return bestScore > 0 ? best : -1;
}

export type CompositeStep = { name: string; status: "ok" | "warn" | "error"; message?: string };

/**
 * Run schananas/grounded_sam (Grounding-DINO + SAM) on ONE label to get a
 * pixel-precise mask (white=element, black=elsewhere) as a URL.
 * Returns null if segmentation fails or nothing is detected.
 */
async function segmentOneWithGroundedSam(imageUrl: string, label: string): Promise<string | null> {
  const lovableKey = process.env.LOVABLE_API_KEY!;
  const replicateKey = process.env.REPLICATE_API_KEY!;
  const version = await getModelVersion("schananas", "grounded_sam");

  let createRes: Response | null = null;
  let lastBody = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    createRes = await fetch(`${REPLICATE_GATEWAY}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": replicateKey,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({
        version,
        input: {
          image: imageUrl,
          mask_prompt: label,
          negative_mask_prompt: "background, white paper, text label",
          adjustment_factor: 0,
        },
      }),
    });
    if (createRes.ok || (createRes.status < 500 && createRes.status !== 429)) break;
    lastBody = await createRes.text();
    let waitMs = 2000 * Math.pow(2, attempt);
    try { const j = JSON.parse(lastBody); if (j?.retry_after) waitMs = Number(j.retry_after) * 1000 + 500; } catch {}
    await new Promise((r) => setTimeout(r, Math.min(15000, waitMs)));
  }
  if (!createRes || !createRes.ok) {
    console.warn(`[grounded_sam] "${label}" create failed:`, createRes?.status, lastBody.slice(0, 200));
    return null;
  }
  let pred = await createRes.json();
  for (let i = 0; i < 40 && (pred.status === "starting" || pred.status === "processing"); i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 1500 : 3000));
    const pollRes = await fetch(`${REPLICATE_GATEWAY}/predictions/${pred.id}`, {
      headers: { Authorization: `Bearer ${lovableKey}`, "X-Connection-Api-Key": replicateKey },
    });
    if (!pollRes.ok) return null;
    pred = await pollRes.json();
  }
  if (pred.status !== "succeeded") {
    console.warn(`[grounded_sam] "${label}" ${pred.status}:`, JSON.stringify(pred.error || "").slice(0, 200));
    return null;
  }
  // Output is [annotated, neg_annotated, mask, inverted_mask] — index 2 is the positive mask (white on black).
  const out = pred.output;
  if (Array.isArray(out) && out.length >= 3 && typeof out[2] === "string") return out[2];
  if (typeof out === "string") return out;
  return null;
}

export const generateSceneComposite = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => CompositeInput.parse(d))
  .handler(async ({ data }) => {
    const steps: CompositeStep[] = [];

    // 1) Generate ONE composite image (OpenAI gpt-image-1)
    let compositeUrl: string;
    try {
      compositeUrl = await generateCompositeImage(data.compositePrompt, data.title);
      steps.push({ name: "composite", status: "ok" });
    } catch (e: any) {
      steps.push({ name: "composite", status: "error", message: e?.message || "failed" });
      throw new Error(`composite: ${e?.message || "failed"}`);
    }

    // 2) Ask GPT-4o vision to inspect the composite and return each element's
    //    bbox + a redraw prompt. Replaces upload+Grounding-DINO+match.
    let visionElements: Awaited<ReturnType<typeof analyzeCompositeWithVision>> = [];
    try {
      visionElements = await analyzeCompositeWithVision(compositeUrl, data.compositePrompt);
      steps.push({
        name: "analyze",
        status: visionElements.length ? "ok" : "warn",
        message: `${visionElements.length} elements`,
      });
    } catch (e: any) {
      steps.push({ name: "analyze", status: "warn", message: e?.message || "vision failed" });
    }

    const elements = visionElements.map((el) => ({
      id: el.id,
      label: el.label,
      prompt: el.prompt,
      bbox: el.bbox,
      maskUrl: null as string | null,
    }));

    return { compositeUrl, elements, steps };
  });



// ---------- Debug: multi-detector segmentation of an ARBITRARY uploaded image ----------
// Pipeline:
//   1) Upload once to Replicate
//   2) In parallel: Gemini vision bboxes, Florence-2 DENSE_REGION_CAPTION, Florence-2 OCR_WITH_REGION
//   3) Reconcile (IoU-merge, dedupe, drop garbage) on the client
//   4) For each surviving detection, either:
//        type=text        → skip SAM, use plain rectangle crop
//        type=object/etc  → run grounded_sam by label for a pixel-precise mask
//
const SegmentImageInput = z.object({
  imageDataUrl: z.string().min(1),
  granularity: z.enum(["fine", "coarse"]).optional().default("fine"),
});

type DetType = "text" | "object" | "icon" | "arrow" | "frame";
type DetSource = "gemini" | "florence" | "ocr";
type RawDet = {
  label: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
  type: DetType;
  source: DetSource;
};

function classifyLabel(label: string): DetType {
  const l = label.toLowerCase();
  if (/(arrow|line pointing|pointer)/.test(l)) return "arrow";
  if (/(icon|symbol|emoji)/.test(l)) return "icon";
  if (/(box|frame|panel|container|border|rectangle|card)/.test(l)) return "frame";
  return "object";
}

// ---- Detector 1: Gemini 2.5 vision → structured bboxes ----
async function detectWithGemini(
  imageDataUrl: string,
  granularity: "fine" | "coarse",
): Promise<RawDet[]> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");

  const granRule =
    granularity === "fine"
      ? `List EVERY distinct visible element separately — icons, arrows, small text labels, frames, characters, objects. Aim for 8–20 elements.`
      : `Group the image into 3–8 semantic UNITS (e.g. "hearing panel with icon and label", not the icon + label separately).`;

  const sys = `You are an expert vision annotator. Look at the image and return a JSON list of every distinct element with its bounding box.

${granRule}

Return ONLY strict JSON with this exact shape:
{ "elements": [ { "label": "...", "type": "text|object|icon|arrow|frame", "bbox": [x0, y0, x1, y1], "confidence": 0.0-1.0 } ] }

Rules:
- bbox = [x0, y0, x1, y1] with values NORMALIZED to 0..1 (fractions of image width/height, top-left origin).
- label = a short concrete noun phrase (2-6 words), e.g. "golden retriever illustration", "hearing icon", "text saying powerful jaws", "green arrow pointing right".
- type: "text" for pure written words/sentences, "arrow" for connectors, "icon" for small pictograms, "frame" for containers/boxes/panels, "object" for everything else (illustrations, characters).
- confidence: your certainty this is a real distinct element, 0.4–1.0.
- Do NOT return the whole image as one element. Do NOT return duplicates.`;

  const res = await fetch(`${AI_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // gemini-2.5-flash: non-reasoning, follows JSON schema reliably.
      // 2.5-pro burns most of the token budget on hidden reasoning tokens and
      // routinely returns an empty content string here.
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: sys },
        {
          role: "user",
          content: [
            { type: "text", text: "Annotate every element in this image." },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 8000,
    }),
  });
  if (!res.ok) throw new Error(`gemini-detect: ${res.status} ${await res.text()}`);
  const j = await res.json();
  const raw = j.choices?.[0]?.message?.content ?? "{}";
  let parsed: any = {};
  try { parsed = JSON.parse(raw); } catch (e) {
    console.warn("[gemini-detect] JSON parse failed:", raw.slice(0, 300));
  }
  const arr = Array.isArray(parsed.elements) ? parsed.elements : [];
  if (arr.length === 0) {
    console.warn("[gemini-detect] 0 elements. Raw content:", raw.slice(0, 500), "finish:", j.choices?.[0]?.finish_reason);
  }
  const out: RawDet[] = [];
  for (const e of arr) {
    const bb = Array.isArray(e?.bbox) ? e.bbox.map(Number) : null;
    if (!bb || bb.length < 4 || bb.some((n: any) => !isFinite(n))) continue;
    let [x1, y1, x2, y2] = bb;
    // If model returned pixel-space (0..1000 or larger), normalize.
    const maxV = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2));
    if (maxV > 1.5) {
      const div = maxV > 100 ? 1000 : maxV > 1.5 ? maxV : 1;
      x1 /= div; y1 /= div; x2 /= div; y2 /= div;
    }
    const x = Math.max(0, Math.min(x1, x2));
    const y = Math.max(0, Math.min(y1, y2));
    const w = Math.max(0, Math.min(1 - x, Math.abs(x2 - x1)));
    const h = Math.max(0, Math.min(1 - y, Math.abs(y2 - y1)));
    if (w < 0.01 || h < 0.01) continue;
    const type: DetType = ["text", "object", "icon", "arrow", "frame"].includes(e?.type)
      ? e.type
      : classifyLabel(String(e?.label ?? ""));
    out.push({
      label: String(e?.label ?? "element").slice(0, 80),
      bbox: { x, y, w, h },
      confidence: Math.max(0, Math.min(1, Number(e?.confidence ?? 0.7))),
      type,
      source: "gemini",
    });
  }
  return out;
}

// ---- Detector 2 & 3: Florence-2 (dense region caption + OCR with region) ----
async function runFlorence(
  imageUrl: string,
  task: "<DENSE_REGION_CAPTION>" | "<OCR_WITH_REGION>",
): Promise<any> {
  const lovableKey = process.env.LOVABLE_API_KEY!;
  const replicateKey = process.env.REPLICATE_API_KEY!;
  const version = await getModelVersion("lucataco", "florence-2-large");

  let createRes: Response | null = null;
  let lastBody = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    createRes = await fetch(`${REPLICATE_GATEWAY}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": replicateKey,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({
        version,
        input: { image: imageUrl, task_input: task },
      }),
    });
    if (createRes.ok || (createRes.status < 500 && createRes.status !== 429)) break;
    lastBody = await createRes.text();
    let waitMs = 2000 * Math.pow(2, attempt);
    try { const jj = JSON.parse(lastBody); if (jj?.retry_after) waitMs = Number(jj.retry_after) * 1000 + 500; } catch {}
    await new Promise((r) => setTimeout(r, Math.min(15000, waitMs)));
  }
  if (!createRes || !createRes.ok) {
    throw new Error(`florence ${task}: ${createRes?.status} ${lastBody.slice(0, 200)}`);
  }
  let pred = await createRes.json();
  for (let i = 0; i < 40 && (pred.status === "starting" || pred.status === "processing"); i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 1500 : 3000));
    const pollRes = await fetch(`${REPLICATE_GATEWAY}/predictions/${pred.id}`, {
      headers: { Authorization: `Bearer ${lovableKey}`, "X-Connection-Api-Key": replicateKey },
    });
    if (!pollRes.ok) throw new Error(`florence poll: ${pollRes.status}`);
    pred = await pollRes.json();
  }
  if (pred.status !== "succeeded") {
    throw new Error(`florence ${task} ${pred.status}: ${JSON.stringify(pred.error || "").slice(0, 200)}`);
  }
  return pred.output;
}

// Florence's DENSE_REGION_CAPTION output shape is roughly:
//   { text: "<DENSE_REGION_CAPTION>{'bboxes': [[x1,y1,x2,y2], ...], 'labels': [...]}" }
// or already a parsed object depending on version. We handle both.
function parseFlorenceRegions(output: any, source: DetSource, defaultType: DetType): RawDet[] {
  if (!output) return [];
  let payload: any = output;
  if (typeof payload === "string") {
    // strip task tag prefix
    const cleaned = payload.replace(/^<[^>]+>/, "").trim();
    // Florence returns Python-style dicts sometimes — swap single→double quotes.
    try { payload = JSON.parse(cleaned); } catch {
      try { payload = JSON.parse(cleaned.replace(/'/g, '"')); } catch { return []; }
    }
  }
  // Common wrappers.
  if (payload && typeof payload === "object") {
    const tag = defaultType === "text" ? "<OCR_WITH_REGION>" : "<DENSE_REGION_CAPTION>";
    if (payload[tag]) payload = payload[tag];
  }
  const bboxes: any[] = payload?.bboxes || payload?.quad_boxes || [];
  const labels: any[] = payload?.labels || [];
  // Assume Florence returns pixel coords in original image space. We normalize
  // using the fact we requested against the source image — the actual dims
  // aren't returned. Fallback: divide by 1000 (Florence's normalized space).
  // Since we can't know image size here, we assume 1000-scale (Florence default)
  // and clamp to [0,1]. If pixels exceed 1500, fall back to /1500.
  const out: RawDet[] = [];
  for (let i = 0; i < bboxes.length; i++) {
    const box = bboxes[i];
    if (!Array.isArray(box) || box.length < 4) continue;
    let [x1, y1, x2, y2]: number[] = [Number(box[0]), Number(box[1]), Number(box[2]), Number(box[3])];
    const maxV = Math.max(x1, y1, x2, y2);
    const divisor = maxV > 1500 ? maxV : 1000;
    x1 /= divisor; y1 /= divisor; x2 /= divisor; y2 /= divisor;
    const x = Math.max(0, Math.min(x1, x2));
    const y = Math.max(0, Math.min(y1, y2));
    const w = Math.max(0, Math.min(1 - x, Math.abs(x2 - x1)));
    const h = Math.max(0, Math.min(1 - y, Math.abs(y2 - y1)));
    if (w < 0.01 || h < 0.01) continue;
    const rawLabel = String(labels[i] ?? (defaultType === "text" ? "text" : "element")).trim();
    const type: DetType = defaultType === "text" ? "text" : classifyLabel(rawLabel);
    out.push({
      label: rawLabel.slice(0, 80),
      bbox: { x, y, w, h },
      confidence: 0.7, // Florence doesn't return per-box confidence for these tasks
      type,
      source,
    });
  }
  return out;
}

async function detectWithFlorenceRegions(imageUrl: string): Promise<RawDet[]> {
  const out = await runFlorence(imageUrl, "<DENSE_REGION_CAPTION>");
  return parseFlorenceRegions(out, "florence", "object");
}
async function detectWithFlorenceOCR(imageUrl: string): Promise<RawDet[]> {
  const out = await runFlorence(imageUrl, "<OCR_WITH_REGION>");
  return parseFlorenceRegions(out, "ocr", "text");
}

// Reconciliation (server-side, mirrors client util so we can filter before sending).
function reconcileServer(inputs: RawDet[]): { kept: RawDet[]; rejected: Array<RawDet & { reason: string }> } {
  const rejected: Array<RawDet & { reason: string }> = [];
  const gated: RawDet[] = [];
  for (const d of inputs) {
    const area = d.bbox.w * d.bbox.h;
    if (area < 0.001) { rejected.push({ ...d, reason: "bbox too small" }); continue; }
    if (area > 0.95) { rejected.push({ ...d, reason: "bbox covers whole image" }); continue; }
    gated.push(d);
  }
  const iouAB = (a: RawDet["bbox"], b: RawDet["bbox"]) => {
    const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
    const inter = ix * iy, union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
  };
  const pri = (d: RawDet) => (d.type === "text" && d.source === "ocr" ? 100 : d.source === "florence" ? 60 : d.source === "gemini" ? 50 : 40);
  gated.sort((a, b) => pri(b) + b.confidence * 10 - (pri(a) + a.confidence * 10));
  const used = new Array(gated.length).fill(false);
  const kept: RawDet[] = [];
  for (let i = 0; i < gated.length; i++) {
    if (used[i]) continue;
    const cur = gated[i];
    used[i] = true;
    for (let j = i + 1; j < gated.length; j++) {
      if (used[j]) continue;
      const ov = iouAB(cur.bbox, gated[j].bbox);
      if (ov >= 0.55) used[j] = true;
    }
    kept.push(cur);
    if (kept.length >= 30) break;
  }
  return { kept, rejected };
}

// Concurrency-limited parallel map.
async function pMap<T, R>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const segmentUploadedImage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SegmentImageInput.parse(d))
  .handler(async ({ data }) => {
    const steps: CompositeStep[] = [];

    // 1) Upload once.
    let uploadUrl: string;
    try {
      uploadUrl = await uploadToReplicate(data.imageDataUrl);
      steps.push({ name: "upload", status: "ok" });
    } catch (e: any) {
      steps.push({ name: "upload", status: "error", message: e?.message || "upload failed" });
      throw new Error(`upload: ${e?.message || "failed"}`);
    }

    // 2) Detectors. Gemini runs in parallel with Replicate, but the two
    //    Replicate/Florence calls MUST be sequential — Replicate's free-tier
    //    burst limit is 1 concurrent prediction and firing both at once
    //    guarantees a 422 "throttled" on the second.
    const geminiPromise = detectWithGemini(data.imageDataUrl, data.granularity);
    const florencePromise = detectWithFlorenceRegions(uploadUrl)
      .then(async (regions) => {
        // Small spacer so the OCR call doesn't collide with the region call.
        await new Promise((r) => setTimeout(r, 1200));
        return regions;
      });
    const ocrPromise = florencePromise
      .catch(() => [])
      .then(() => detectWithFlorenceOCR(uploadUrl));

    const [geminiRes, florenceRes, ocrRes] = await Promise.allSettled([
      geminiPromise,
      florencePromise,
      ocrPromise,
    ]);

    const gemini = geminiRes.status === "fulfilled" ? geminiRes.value : [];
    const florence = florenceRes.status === "fulfilled" ? florenceRes.value : [];
    const ocr = ocrRes.status === "fulfilled" ? ocrRes.value : [];

    steps.push({
      name: "gemini",
      status: geminiRes.status === "fulfilled" ? (gemini.length ? "ok" : "warn") : "error",
      message:
        geminiRes.status === "fulfilled"
          ? `${gemini.length} elements`
          : (geminiRes as any).reason?.message?.slice(0, 200) ?? "failed",
    });
    steps.push({
      name: "florence",
      status: florenceRes.status === "fulfilled" ? (florence.length ? "ok" : "warn") : "error",
      message:
        florenceRes.status === "fulfilled"
          ? `${florence.length} regions`
          : (florenceRes as any).reason?.message?.slice(0, 200) ?? "failed",
    });
    steps.push({
      name: "ocr",
      status: ocrRes.status === "fulfilled" ? (ocr.length ? "ok" : "warn") : "error",
      message:
        ocrRes.status === "fulfilled"
          ? `${ocr.length} text runs`
          : (ocrRes as any).reason?.message?.slice(0, 200) ?? "failed",
    });

    // 3) Reconcile.
    const allDets = [...gemini, ...florence, ...ocr];
    const { kept, rejected } = reconcileServer(allDets);
    steps.push({
      name: "reconcile",
      status: kept.length ? "ok" : "warn",
      message: `${kept.length} kept, ${rejected.length} rejected`,
    });

    // 4) Extract per-element: text → rect (no SAM), object/icon/arrow/frame → SAM by label.
    const samTargets = kept.filter((d) => d.type !== "text");
    let maskCount = 0;
    const masksByIdx = new Map<number, string | null>();
    if (samTargets.length) {
      const masks = await pMap(samTargets, 4, async (d) => {
        try {
          const m = await segmentOneWithGroundedSam(uploadUrl, d.label);
          if (m) maskCount++;
          return m;
        } catch (e: any) {
          console.warn(`[sam] "${d.label}" failed:`, e?.message);
          return null;
        }
      });
      // Map back to indices in `kept`.
      let si = 0;
      for (let i = 0; i < kept.length; i++) {
        if (kept[i].type === "text") continue;
        masksByIdx.set(i, masks[si] ?? null);
        si++;
      }
    }
    steps.push({
      name: "sam",
      status: samTargets.length === 0 ? "ok" : maskCount === 0 ? "warn" : "ok",
      message: `${maskCount}/${samTargets.length} masks`,
    });

    const elements = kept.map((d, i) => ({
      label: d.label,
      bbox: d.bbox,
      confidence: d.confidence,
      type: d.type,
      source: d.source,
      maskUrl: masksByIdx.get(i) ?? null,
      cropMode: (d.type === "text" ? "rect" : "mask") as "rect" | "mask" | "white",
    }));

    return {
      uploadUrl,
      elements,
      rejected: rejected.map((r) => ({
        label: r.label,
        bbox: r.bbox,
        confidence: r.confidence,
        type: r.type,
        source: r.source,
        reason: r.reason,
      })),
      raw: {
        gemini: gemini.length,
        florence: florence.length,
        ocr: ocr.length,
      },
      steps,
    };
  });


// ---------- TTS (ElevenLabs v3, Liam voice) ----------
const TtsInput = z.object({ text: z.string().min(1).max(4000) });

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
