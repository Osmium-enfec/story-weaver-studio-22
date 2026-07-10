# Better Element Extraction — Plan

## Diagnosis of current failures

From your screenshot:
- **Duplicate/garbage labels** — "main text box" appears 3x, "icon eye icon" nonsense phrases from Gemini's blind auto-list
- **Low DINO confidence (0.27–0.48)** on icons, arrows, hand-drawn frames — DINO was trained on real photos, not whiteboard illustrations
- **Empty SAM masks** — SAM anchored on wrong points inside low-confidence bboxes (hearing/eye/smell icons blank)
- **Wrong crops** — bboxes overlap, then SAM masks the background layer
- **No spatial grounding** — labels have no coordinates to disambiguate 3 "text box" matches

## New pipeline: 3 detectors in parallel, best-mask-wins

Replace the linear `list → DINO → SAM` chain with a parallel-detector + reconciliation pipeline. Each element gets extracted by whichever detector performs best for its type.

```text
                        ┌─ Gemini 2.5 (vision + bboxes) ──┐
Uploaded image ─────────┼─ Florence-2 (dense region cap) ─┼─► Reconcile & dedupe ─► SAM 2 refine ─► Crop
                        └─ PaddleOCR (text rectangles) ───┘
```

### Stage 1 — Three parallel detectors

1. **Gemini 2.5 Pro with bbox output** (`lucataco/florence-2-large` also considered but Gemini is stronger on stylized art). Prompt returns JSON: `[{label, bbox: [x0,y0,x1,y1], type: "object"|"text"|"icon"|"arrow"|"frame"}]` normalized 0–1. Solves the "no spatial grounding" problem — no more blind label lists.
2. **Florence-2 Large** on Replicate (`lucataco/florence-2-large`, task=`<DENSE_REGION_CAPTION>`) — catches small icons/arrows Gemini misses, works well on illustrations.
3. **PaddleOCR** on Replicate (`cjwbw/paddleocr` or `abiruyt/text-extract-ocr`) — precise rectangles for every text run. These bypass SAM entirely.

Run all three in parallel via `Promise.all`.

### Stage 2 — Reconcile & dedupe

- Merge detections from Gemini + Florence-2 by IoU > 0.6 → keep the higher-confidence label
- Attach OCR text rectangles as `type: "text"` elements
- Drop detections with confidence < 0.35 unless no overlap exists
- Log dropped/merged items in the UI

### Stage 3 — Type-aware extraction

- **`type: "text"`** → rectangle crop from OCR bbox, no SAM. Alpha = full opaque.
- **`type: "object" | "icon" | "arrow" | "frame"`** → SAM 2 (`meta/sam-2`, not the older grounded-sam) using **bbox as prompt AND center-point as positive point** (dramatically improves mask quality on stylized art vs bbox-only).
- **`type: "frame"`** → try SAM first, fallback to bbox rectangle if mask is <5% or >95% of bbox area (bad mask).

### Stage 4 — Mask quality gate

Before showing an element:
- Reject masks where alpha coverage <3% (blank) or >95% (whole image)
- Reject if mask centroid is >30% away from bbox center
- Fallback: use bbox rectangle crop with soft feathered edges

## Segment Lab UI changes

- Remove the labels input entirely — everything auto-detects now
- Add toggle: **"Semantic groups"** vs **"Every visible object"** (passes different Gemini prompt: coarse panels vs fine elements)
- Show per-detector breakdown: which detector found each element (Gemini/Florence/OCR), confidence, mask coverage %
- Show rejected detections in a collapsed section with reason (low conf, bad mask, duplicate)
- Add "Retry with adjusted params" button per element

## Files to add / change

**New:**
- `src/lib/detect-florence.functions.ts` — Replicate call to Florence-2 large
- `src/lib/detect-ocr.functions.ts` — Replicate PaddleOCR call
- `src/lib/detect-gemini-bboxes.functions.ts` — Gemini vision returning structured bboxes
- `src/lib/reconcile-detections.ts` — IoU merge, dedupe, quality gates (client-side, pure)
- `src/lib/mask-quality.ts` — coverage/centroid checks

**Change:**
- `src/lib/explainer.functions.ts` — swap `autoListElements` + grounded-sam for new pipeline; keep `segmentUploadedImage` signature stable
- `src/routes/_authenticated/segment-lab.tsx` — remove labels input, add granularity toggle, show detector breakdown & rejections
- `src/lib/crop-composite.ts` — accept either mask or rectangle crop mode

## Rollout

1. Build new pipeline behind a Segment Lab toggle **without touching the main video flow**
2. You test on a handful of infographics in Segment Lab
3. Once quality is confirmed, port into `generateSceneComposite` for the main video pipeline (one-line swap)

## Cost note

You said don't worry about cheap, so this runs all 3 detectors every time. Rough per-image cost: ~$0.02 Gemini + ~$0.005 Florence + ~$0.002 OCR + ~$0.01 SAM-2 per element ≈ $0.05–0.15/image depending on element count. Well within your $6 Replicate budget for testing.

## Open question I'll assume unless you say otherwise

I'll use `meta/sam-2` (the newer, better model) on Replicate instead of the older `schananas/grounded_sam`. It supports both bbox and point prompts, which is what makes the type-aware extraction possible.
