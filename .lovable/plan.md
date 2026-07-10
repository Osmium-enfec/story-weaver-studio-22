## Goal

Cut image-generation credits by generating **one Excalidraw-style composite image per scene** (with arrows, boxes, characters, labels drawn in), then using **Grounded-SAM 2** (text-prompted segmentation on Replicate) to cut each element (character, box, arrow, label) out as a transparent PNG. Elements are then revealed in sequence, timed to narration, on top of the user's background.

Also: stop over-fragmenting scripts. Let Gemini group 1–3 related sentences into a single scene when they visually belong together.

## Changes

### 1. Planner — chunk smarter, output "composite" scenes
`src/lib/explainer.functions.ts` → `planScript`
- New system prompt: "Group 1–3 consecutive sentences into one scene when they describe the same idea. Aim for scenes of 6–18 seconds of narration. Never split a single explanatory beat across scenes."
- Scene output shape for image scenes changes to:
  - `narrationText`: full text for the whole scene (concatenation of grouped sentences).
  - `composition.compositePrompt`: ONE detailed Excalidraw whiteboard prompt describing the whole infographic — layout, arrows, boxes, characters, hand-lettered labels — all drawn together.
  - `composition.elements[]`: each element is now `{ id, label, segmentPrompt, appearAt, anim }`. `segmentPrompt` is the text prompt passed to Grounded-SAM (e.g. `"the dog"`, `"the arrow between box A and box B"`, `"the label 'chunk'"`). No more separate `prompt` per element; no more grid layout — positions come from the segmentation mask.

### 2. Replicate connector
- User links **Replicate** via `standard_connectors--connect` (gateway-backed). Injects `LOVABLE_CONNECTOR_REPLICATE_API_KEY`.
- No custom secret prompt needed.

### 3. New server function: composite + segment
`src/lib/explainer.functions.ts` → new `generateSceneComposite`
- Input: `{ compositePrompt, segmentPrompts: string[] }`.
- Step A: one call to OpenAI `gpt-image-1` (existing pipeline) at 1536×1024 with the full Excalidraw composite prompt (arrows, boxes, characters, labels all baked in).
- Step B: upload the composite to Replicate `/v1/files`, then call Grounded-SAM 2 (e.g. `schananas/grounded_sam` or `meta/sam-2` with text prompts via Grounding DINO) once per `segmentPrompt` OR once with all prompts if the model supports batched labels.
- Step C: for each returned mask, crop the composite to the mask's bounding box and apply the mask as alpha → transparent PNG. Store to `project-assets` bucket. Cache by `sha256(compositePrompt + segmentPrompt)` in `image_assets`.
- Returns `{ compositeUrl, elements: [{ id, mediaUrl, bbox: {x,y,w,h} }] }`. The bbox (normalized 0–1) tells the player exactly where the piece sat in the original composite, so revealing it in place recreates the drawing.

### 4. Player + rasterizer — position by bbox, not grid
`src/components/VideoPlayer.tsx` (`ImageScene`) and `src/lib/rasterize-scene.ts`
- Drop `LAYOUTS` grid lookup for composite scenes.
- Position each element at its returned bbox inside the inset white card. Element image is already a transparent crop; render at natural aspect ratio (no forced 1:1 box).
- Reveal order = `appearAt` from planner; label rendered underneath in Caveat font as today.
- `scene-layouts.ts` stays for backward compat / 1-element fallback only.

### 5. Build/render pipeline
- `src/lib/rasterize-scene.ts` uses the same bbox positioning so exported MP4 matches preview.
- `ffmpeg-stitcher.ts` unchanged.

### 6. UI
`src/routes/index.tsx`
- Progress row shows: 1 composite thumbnail + N element crops (same layout as today).
- No new user-facing controls; segmentation runs automatically after composite generation.
- Fallback: if Grounded-SAM returns 0 masks for a prompt, log it and show the whole composite as a single element for that scene (no crash).

## Credits impact

Per image scene, before: 1 background + N element gens = **N+1 OpenAI image calls**.
After: 1 composite gen + 1 Replicate Grounded-SAM run (all labels batched, ~$0.005–0.02) = **1 OpenAI call + 1 cheap Replicate call**. On a 6-scene video with 4 elements each, that's ~30 → ~6 image calls.

## Open technical notes

- Exact Replicate model id (Grounded-SAM 2 vs Grounded-SAM v1) picked at build time based on which is currently available and supports batched text prompts. Preference: `schananas/grounded_sam` (mature, text-prompted, returns masks).
- Mask → transparent PNG cropping done server-side in the handler using `sharp` — **but** the Cloudflare Worker runtime does not support `sharp`. Fallback: use pure-JS PNG decoding + a Canvas polyfill, or perform the mask compositing on the **client** after downloading the raw mask+composite from the server function (simpler, no native deps). Plan: do the compositing client-side in `remove-white-bg.ts`-style code, keeping the server function returning `{ compositeUrl, masks: [{ id, maskUrl, bbox }] }` and letting the browser produce the transparent element data URLs. This matches the existing white-bg-removal pattern.

## Requires from user before build

1. Link the **Replicate** connector (I'll trigger the connect flow).
2. Confirm you're OK with client-side mask compositing (keeps server simple, no native image deps).