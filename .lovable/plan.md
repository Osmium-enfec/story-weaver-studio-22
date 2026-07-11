## Goal
Explainer scenes should reveal hand-drawn boxes one-by-one (identical to Segment Lab), instead of showing the whole composite image immediately.

## Root causes
1. `detectBoxesInImage` is fed the raw ~1–2 MB `data:image/png;base64,...` composite. Replicate's Grounding‑DINO frequently rejects data URLs that large → the server function returns `{ fallback: true }` → `revealCovers` stays empty → nothing to fade.
2. The reveal pass runs *after* scenes are already shown. If Play starts before it finishes, or on a reloaded project (persisted payload strips `revealCovers`), there are no covers.
3. In `VideoPlayer`, `RevealCoverLayer` is passed `scene.durationMs`, but for master‑audio scenes the on‑screen window is `endMs - startMs`. When these differ, the fade schedule runs outside the visible window and looks like "already revealed".
4. Segment‑lab drives reveals with real setTimeouts; the explainer drives them from audio `progress`. Any mismatch in the time basis makes the boxes flash rather than sequence.

## Changes

### 1. Reliable box detection for explainer composites (`src/lib/explainer.functions.ts`, `src/lib/detect-boxes.functions.ts`)
- Reuse the existing `uploadToReplicate(dataUrl)` helper to convert the composite to a real HTTPS URL before calling Grounding‑DINO. Do this inside `detectBoxesInImage` when the input is a `data:` URL, so both explainer and segment‑lab benefit and behave identically.
- On any Replicate error, keep the current graceful fallback but also return a `reason` string for the UI/log.

### 2. Guaranteed reveal covers (`src/lib/build-reveal.ts`)
- If detection returns `fallback` or `boxes.length === 0`, synthesize a deterministic 2×3 (or 3×2) grid of covers over the inner card area, sorted top→bottom / left→right. This guarantees a "boxes appear one-by-one" feel even when Grounding‑DINO fails, matching the user's expectation.
- Keep detected boxes when available (preferred path).

### 3. Sync reveal timing to the actual on-screen window (`src/components/VideoPlayer.tsx`)
- Pass `windowDurationMs = (endMs - startMs) || scene.durationMs` into `RevealCoverLayer` and to `coverOpacityAt`, so the sequential schedule always fits inside what the user actually sees.
- Do the same substitution in `src/lib/rasterize-scene.ts` so 720p/1080p renders keep matching the live player exactly.

### 4. Don't let the user Play before covers exist (`src/routes/index.tsx`)
- Move the reveal pass to run **before** enabling the Play button (or block Play until `revealCovers` are attached to every image scene). Show the existing `reveal-analyze` step in the progress list as a required step, not an optional post‑pass.
- Persist `revealCovers` (they're tiny: id + shared 1×1 PNG data URL + normalized bbox) so reloading a saved project still reveals sequentially. Remove the current strip in the save payload.

### 5. Diagnostics
- Log `[reveal] scene <i>: detected N boxes` and `[reveal] scene <i>: fallback grid (<reason>)` so we can see in the console which path each scene took.

## Out of scope
- No changes to prompt/style, no re-generation of images, no changes to Segment Lab.

## Technical notes
- `coverOpacityAt(progress, i, total, durationMs)` already implements the exact 250 ms lead + 900 ms step + 900 ms fade schedule Segment Lab uses; only the `durationMs` value it receives needs to be corrected.
- `WHITE_PIXEL_PNG` is shared, so grid fallback covers add virtually zero payload.
