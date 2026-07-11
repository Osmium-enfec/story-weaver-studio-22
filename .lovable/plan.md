# Plan: White-Cover Reveal via SAM Regions

## Goal
After generating the Excalidraw image in Segment Lab, detect every non-white region and produce matching white "cover" overlays. Play these covers on top of the image, then remove them one-by-one (per label) to reveal elements in sequence — no per-element regeneration needed.

## Approach

**Step 1 — Segment as today.** Keep the existing GPT-labels + Grounded-SAM pipeline. Each label already returns a full-size mask URL.

**Step 2 — Per-layer white cover.** For every mask, build a canvas the size of the source image, fill mask pixels with pure white (`#FFFFFF`), leave the rest transparent. Export as PNG. This is the "cover" for that label. Reuse the existing `extractLayer` canvas plumbing in `src/lib/layer-compose.ts` — same mask read, different fill.

**Step 3 — Residual cover (safety net).** SAM masks miss stray strokes and text. After stacking all label covers, diff against the source: any pixel where `min(r,g,b) < 240` and not already covered gets added to a "misc" white cover. Guarantees the starting frame is fully white.

**Step 4 — Reveal playback in Segment Lab.**
- Render the full source image as the base layer.
- Stack all white covers on top → screen looks blank white.
- Sequence: fade out covers one at a time (1s ease), ordered largest-area → smallest (or by label order from GPT).
- Reuse the timeline/preview UI already in Segment Lab; add a "Play reveal" button next to "Generate & Play".

## Files to touch
- `src/lib/layer-compose.ts` — add `extractWhiteCover(sourceUrl, maskUrl)` returning `{ pngUrl, bbox, area }` (mirrors `extractLayer` but fills white).
- `src/lib/layer-compose.ts` — add `buildResidualCover(sourceUrl, existingCoverUrls)` for the safety-net white layer.
- `src/routes/_authenticated/segment-lab.tsx` — after `analyze()` finishes, also build covers; add reveal timeline state + "Play reveal" button; render `<img>` covers positioned by bbox with animated opacity.

## Non-goals
- No changes to generation, SAM call, or the existing transparent-layer extraction. Covers are an additive output alongside current layers.
- No video export in this pass — just in-browser preview playback.

## Open question
Reveal order: **largest-first** (feels like the scene assembles from big shapes down to details) or **GPT label order** (matches narration flow later)? Default to largest-first unless you prefer label order.
