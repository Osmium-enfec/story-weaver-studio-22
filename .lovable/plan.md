
# Segment Lab → Magic Layer Clone

## Recommendation: Option A (upgrade our own pipeline)

Why A over B (hosted API like Photoroom):
- We already own the Replicate connector, Grounded-SAM, and the composite-detection code — most of the plumbing exists.
- Hosted "layer splitter" APIs (Photoroom, Clipdrop) don't actually return semantic layers with labels + z-order; they only do bg-removal or one-object cutout. We'd still have to build the multi-object loop ourselves.
- A gives us full control of the label vocabulary, which matters because our end goal is feeding layers back into the explainer video (each layer needs a stable name + bbox to be animated).
- Cost is the same order of magnitude (~$0.01–0.03/image via Replicate).

Option C (Canva Connect API) is out — Magic Layer isn't exposed externally.

## What we build in Segment Lab (fresh page, replaces current mask-reveal UI)

Single flow: upload image → get back N transparent PNG layers + a JSON manifest → preview them stacked and toggle-able.

### Pipeline (all in one server function, `segmentImageLayers`)

1. **Label discovery** — send the image to `google/gemini-3-flash-preview` via Lovable AI Gateway with a prompt: "list every distinct visual element in this image as short noun phrases, comma-separated". Returns e.g. `"title pill, dog character, arrow, footer robot, option card A, option card B..."`.
2. **Detection** — send image + that label list to Grounding-DINO on Replicate → bboxes per label.
3. **Segmentation** — send image + bboxes to **SAM 2** (`meta/sam-2`) on Replicate → precise mask per bbox.
4. **Merging** — IoU-based merge (>0.7 overlap OR same label + touching bboxes) so sub-parts of one thing collapse into one layer.
5. **Cutout** — for each merged mask, crop the image with the mask as alpha → transparent PNG.
6. **Inpaint background** — run `lama` (or `zylim0702/sd-inpaint`) once on the union of all masks → clean background plate.
7. Return `{ background: dataUrl, layers: [{ id, label, bbox, maskUrl, pngUrl, zIndex }] }`.

Z-index heuristic: smaller bbox area = higher z-index (things on top are usually smaller than things behind).

### UI (Segment Lab rewrite)

Three panels:
- **Left**: uploaded image + "Analyze" button, then progress ("labeling → detecting → segmenting → cutting out → inpainting bg").
- **Center**: preview canvas showing the reconstructed image from stacked layers + background plate. Each layer has a checkbox to show/hide and a slider to offset it (proves layers are truly separated).
- **Right**: layer list — thumbnail, label, bbox, z-index, download-PNG button, "download all as ZIP".

No mask-reveal / MCQ animation stuff in this iteration — we're validating extraction quality first, exactly like you said.

### Files

- `src/lib/segment-layers.functions.ts` — new server fn orchestrating steps 1–6, using Replicate connector via gateway. Uses `LOVABLE_API_KEY` + `LOVABLE_CONNECTOR_REPLICATE_API_KEY`.
- `src/lib/layer-compose.ts` — client helpers: apply mask as alpha, IoU merge, stack layers on canvas.
- `src/routes/_authenticated/segment-lab.tsx` — full rewrite (current mask-reveal code archived, we'll bring bits back later if useful).

### Explicitly out of scope this pass
- Vectorization (SVG trace) — layers stay as PNGs.
- Wiring into the explainer video at `src/routes/index.tsx` — happens only after Segment Lab looks right.
- Manual layer editing (brush, split, merge in UI).

## Technical section

- Replicate connector must be linked to the project before running (`standard_connectors--connect` with `replicate`).
- Server fn uses direct `fetch` to `https://connector-gateway.lovable.dev/replicate/v1/...` per the Replicate knowledge (path must contain `/v1/`, poll our own gateway URL, don't use `urls.get`).
- SAM 2 model on Replicate: `meta/sam-2` — accepts `image` + `points` or `box_prompts`. We feed box_prompts from Grounding-DINO.
- Inpaint model: `cjwbw/lama` (fast, no prompt needed, just mask).
- Long-running (~30–90s total per image); UI streams progress via server-sent updates OR just polls a status field in the response. First cut: single blocking call with a spinner + per-step console logs.
- No new npm deps. Image processing (mask-as-alpha, IoU) done in-browser via Canvas 2D — same pattern as existing `crop-composite.ts`.
- Auth: gated behind `_authenticated/` so `requireSupabaseAuth` middleware works.
