
# Segment Lab → Mask-Based Reveal Studio

Pivot Segment Lab from "crop image into 7 tiles" to a **mask-reveal editor**: the original PNG is never modified; opaque white rectangles cover regions and animate away on a timeline.

## Scope (MVP — this iteration)

Single-page tool at `/segment-lab`. No backend changes, no image generation, no video export yet. Everything runs client-side. Later iterations wire this into the main explainer pipeline.

## What we build

### 1. Layout template system
New file `src/lib/mask-templates.ts` defining reusable templates. Start with:
- `mcq-four-card` (title, subtitle, 4 option cards, answer banner) — using the 1659×948 boxes already in segment-lab
- `comparison-two-column`
- `three-step-process`
- `title-with-three-points`

Each template = `{ id, canvas: {w,h}, regions: [{id, label, x, y, w, h, safetyPadding}] }`. Coordinates stored as fractions so any canvas size works.

### 2. Rewritten Segment Lab page (`src/routes/_authenticated/segment-lab.tsx`)

Three-panel layout:

**Left panel** — template picker + region list
- Choose template (dropdown)
- List of regions with visibility toggles, drag-to-reorder for reveal sequence

**Center panel** — canvas
- Uploaded PNG rendered as `<img>` at natural size (scaled to fit)
- Absolutely-positioned white `<div>` masks per region (with `safetyPadding` expansion)
- Masks draggable + resizable via handles (plain mouse events, no external lib for MVP)
- Toggle "show mask outlines" for editing vs preview

**Right panel** — selected region properties
- x, y, w, h numeric inputs
- Reveal animation: `fade | wipe-left | wipe-right | wipe-up | wipe-down | instant`
- Start time (ms), duration (ms)
- Ease: `linear | ease-out | ease-in-out`

**Bottom bar** — timeline + transport
- Play / Pause / Restart
- Scrubber showing region reveal markers
- Total duration auto-computed from last region end

### 3. Reveal engine
New file `src/lib/mask-reveal.ts` — pure functions:
- `computeMaskStyle(region, timeMs, animation)` returns CSS `{opacity, transform, transition}` for the current time
- Driven by a `requestAnimationFrame` loop in the page while playing
- Instant apply (scrub) also supported

Animations use CSS `transform: scaleX/scaleY` with `transform-origin` for wipes, `opacity` for fade — matches the writeup exactly.

### 4. Persistence (local only for MVP)
Save/load current scene (template id + region overrides + timeline) to `localStorage` under `segment-lab:scene`. Export/import JSON button so a scene can be copied out.

## Explicitly out of scope this pass
- Image generation with template-constrained prompts (next step, will reuse `src/lib/image-library.functions.ts`)
- Polygon / brush masks (rectangles only for MVP)
- Non-white background handling
- Video export via ffmpeg / Remotion (next step, will reuse `src/lib/ffmpeg-stitcher.ts`)
- Voiceover sync (next step)
- Wiring into the main explainer flow at `src/routes/index.tsx`

Once the mask editor + timeline preview feel right, we layer generation → export → voiceover sync on top in follow-up plans.

## Technical section

- No new npm deps. Native DOM drag/resize handles; no Fabric/Konva yet (keeps bundle small; can upgrade later if polygon/brush is needed).
- Canvas display uses CSS scale so internal coordinates stay in image pixels (matches how current `SLICE_LAYOUT` works).
- Region `safetyPadding` defaults to 24px; mask box = content box expanded by padding on all sides.
- Timeline loop uses `performance.now()` + `rAF`; pausing captures elapsed offset.
- File touched: `src/routes/_authenticated/segment-lab.tsx` (full rewrite). New files: `src/lib/mask-templates.ts`, `src/lib/mask-reveal.ts`.
- Existing 1659×948 MCQ coordinates become the seed data for the `mcq-four-card` template so nothing you already dialed in is lost.

## Open questions before I build

1. For the MVP, is starting with just the `mcq-four-card` template enough, or do you want all four templates wired from day one?
2. Should the uploaded image and scene state persist across reloads (localStorage), or is in-memory fine for now?
