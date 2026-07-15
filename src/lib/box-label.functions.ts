import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { OPENAI_API, openAIHeaders, requireOpenAIKey } from "@/lib/openai-env";
import type { BoxRole, RevealCover } from "@/lib/build-reveal";
import { classifyBoxesHeuristic } from "@/lib/binding-reveal-schedule";
import { resolveSingleFooterIndex } from "@/lib/script-stt-sync";

const LabelInput = z.object({
  imageDataUrl: z.string().min(20),
  covers: z.array(
    z.object({
      id: z.string(),
      pngUrl: z.string(),
      bbox: z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
      }),
    }),
  ),
  sceneTitle: z.string().optional(),
});

/** OCR/vision: read each box's role + label for semantic audio matching. */
export const labelRevealBoxes = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => LabelInput.parse(d))
  .handler(async ({ data }): Promise<{ covers: RevealCover[] }> => {
    const base = data.covers as RevealCover[];
    try {
      requireOpenAIKey();
    } catch {
      return { covers: classifyBoxesHeuristic(base) };
    }

    const boxList = base
      .map(
        (c, i) =>
          `${i}: bbox x=${c.bbox.x.toFixed(2)} y=${c.bbox.y.toFixed(2)} w=${c.bbox.w.toFixed(2)} h=${c.bbox.h.toFixed(2)}`,
      )
      .join("\n");

    const sys = `You label hand-drawn whiteboard infographic boxes. For each numbered box region, return:
- role: "title" | "subtitle" | "footer" | "content" | "hub"
  - title: top main heading banner
  - subtitle: one-line description under title
  - footer: bottom summary/takeaway strip
  - hub: central connector OR tall mascot/character panel on the right (robot, snake, owl in lively pose)
  - content: concept/data-type cards in the middle area
- label: the main visible text/header inside that box (2-6 words max)
- matchTerms: 1-4 keywords to search in spoken audio — include how the narrator says it (e.g. label "String" → ["strings", "string"], "Integer" → ["integers", "integer"])

Return ONLY JSON: { "boxes": [ { "index": 0, "role": "...", "label": "...", "matchTerms": ["..."] }, ... ] }`;

    try {
      const res = await fetch(`${OPENAI_API}/chat/completions`, {
        method: "POST",
        headers: openAIHeaders(),
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: sys },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Scene title hint: ${data.sceneTitle ?? "(none)"}\n\nBox regions (normalized 0-1):\n${boxList}\n\nLabel each box.`,
                },
                { type: "image_url", image_url: { url: data.imageDataUrl } },
              ],
            },
          ],
          response_format: { type: "json_object" },
          max_tokens: 1200,
        }),
      });
      if (!res.ok) throw new Error(`label failed ${res.status}`);
      const j = await res.json();
      const parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
      const arr = Array.isArray(parsed.boxes) ? parsed.boxes : [];
      const roles: BoxRole[] = ["title", "subtitle", "footer", "content", "hub"];

      const labeled = base.map((c, i) => {
        const hit = arr.find((b: { index?: number }) => Number(b.index) === i) ?? arr[i];
        const role = roles.includes(hit?.role) ? (hit.role as BoxRole) : undefined;
        const label = String(hit?.label ?? "").trim() || undefined;
        const matchTerms = Array.isArray(hit?.matchTerms)
          ? hit.matchTerms.map(String).filter(Boolean)
          : label
            ? [label]
            : [];
        return { ...c, role, label, matchTerms };
      });

      return { covers: demoteDuplicateFooters(classifyBoxesHeuristic(labeled)) };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[label-boxes]", msg);
      return { covers: demoteDuplicateFooters(classifyBoxesHeuristic(base)) };
    }
  });

/** Only the bottom strip is footer; mis-detected inner boxes become content. */
function demoteDuplicateFooters(covers: RevealCover[]): RevealCover[] {
  const bindings = covers.map((c) => ({
    boxId: c.id,
    role: c.role ?? "content",
    displayLabel: c.label ?? c.id,
    spokenPhrases: [] as string[],
    searchTerms: [] as string[],
  }));
  const keepFooter = resolveSingleFooterIndex(covers, bindings);
  if (keepFooter < 0) return covers;
  return covers.map((c, i) =>
    c.role === "footer" && i !== keepFooter ? { ...c, role: "content" as BoxRole } : c,
  );
}
