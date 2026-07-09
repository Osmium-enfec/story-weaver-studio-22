# Hybrid Export: Canvas Rasterizer + ffmpeg.wasm Stitcher

Keep our current canvas animation code as the "renderer" (it already knows how to draw image comps, code scenes, stock video, Ken Burns, element reveals). Add ffmpeg.wasm as the "encoder + muxer + stitcher" so the final output is a real MP4 with continuous audio.

## Pipeline

```text
per scene:
  canvas draw loop  ─►  PNG frame sequence (in ffmpeg wasm FS)
                          │
                          ▼
                  ffmpeg encode → segN.mp4 (H.264, silent, exact duration)

all scenes done:
  segments + master audio ─► ffmpeg concat + mux ─► final.mp4 (H.264 + AAC)
```

Result: real MP4, seekable, correct duration, real AAC audio, no MediaRecorder / no `fix-webm-duration` hack.

## Steps

### 1. Add ffmpeg.wasm
- `bun add @ffmpeg/ffmpeg @ffmpeg/util @ffmpeg/core`
- Singleton loader `getFFmpeg()` (load once per session, ~25MB), progress + log handlers, same pattern as Frame Animator Magic.

### 2. New file `src/lib/rasterize-scene.ts`
Extract the pure "draw one frame of scene X at time T" logic out of `render-video.ts`:
- `drawImageSceneFrame(ctx, scene, progress, W, H, bgImg, elementImgs)`
- `drawCodeSceneFrame(ctx, scene, progress, W, H)`
- `drawStockFrame(ctx, videoEl, W, H)`
- Asset preloader (image cache, video element cache) — reused by both live player export and rasterizer.

This makes the drawing code testable and decouples it from `MediaRecorder`.

### 3. New file `src/lib/ffmpeg-stitcher.ts`
Core exporter, replaces the MediaRecorder path in `render-video.ts`:

```ts
export async function exportToMp4(
  scenes: Scene[],
  masterAudioUrl: string | undefined,
  quality: "preview" | "hd",
  onProgress: (stage: string, ratio: number) => void,
): Promise<Blob>
```

Flow:
1. Preload all scene assets (images, stock videos, master audio bytes).
2. For each scene:
   - Compute duration frames = `round(durationMs / 1000 * fps)`.
   - For stock scenes, seek the `<video>` per frame via `video.currentTime = t; await 'seeked'` and draw. (Reliable in headless drawing, no realtime dependency.)
   - Draw frame to offscreen canvas → `canvas.toBlob('image/png')` → `ffmpeg.writeFile('scene{i}/f_%05d.png', bytes)`.
   - Progress: report `(scene i of N, frame k of M)` back to caller.
3. Encode segment:
   ```
   ffmpeg -y -framerate {fps} -i scene{i}/f_%05d.png
     -c:v libx264 -preset {preset} -crf {crf}
     -pix_fmt yuv420p -movflags +faststart segN.mp4
   ```
   Delete the PNG frames after encode to free wasm heap.
4. After all segments:
   - Concat: `ffmpeg -f concat -safe 0 -i list.txt -c copy video.mp4`
   - Mux master audio:
     ```
     ffmpeg -y -i video.mp4 -i master.wav
       -c:v copy -c:a aac -b:a 192k -shortest final.mp4
     ```
   - Read `final.mp4` → `Blob({ type: 'video/mp4' })` → return.

Quality presets (match Frame Animator style):
- `preview`: 1280×720, 30fps, `-preset ultrafast -crf 26`
- `hd`: 1920×1080, 60fps, `-preset veryfast -crf 20`

### 4. Wire up `VideoPlayer`
- Replace the `renderVideo` call in `handleExport` with `exportToMp4`.
- Change download extension `.webm` → `.mp4`.
- Progress UI: show `stage` label ("scene 3/6 · frame 42/120", "encoding", "stitching", "muxing audio") next to the % bar — much more informative than the current single number.
- Keep both "Current quality" and "HD" buttons.

### 5. Keep the current MediaRecorder path as fallback
Leave `render-video.ts` intact for one release cycle behind a flag (`USE_FFMPEG = true`) in case ffmpeg.wasm fails on some browser. Delete once verified.

## Handling scene types under ffmpeg

- **Image comp scenes**: purely canvas — trivially rasterized per frame.
- **Code scenes**: currently rendered by React (`CodeScene.tsx` uses DOM/SVG). We already have `drawCodeScene` in `render-video.ts` doing a canvas version — reuse it (typing progress based on `progress`).
- **Stock video scenes**: seek the `HTMLVideoElement` per frame and draw. Slower but deterministic.
- **Crossfades between scenes**: today they're a DOM CSS transition. For MP4 output we bake them in — during the last 700ms of scene N and first 700ms of scene N+1, we render an overlap by drawing scene N+1 with rising alpha on top of scene N. Two implementation choices:
  - (a) Extend each segment by 700ms of overlap frames, then use ffmpeg `xfade` filter at concat time. Cleanest.
  - (b) Render the overlap frames into a dedicated `transitionN.mp4` and interleave via concat. Simpler.
  Plan: go with (a) — `xfade=transition=fade:duration=0.7:offset={segDur-0.7}` — one filtergraph, no extra passes.

## Master audio for the mux

- Script mode: we already produce a concatenated WAV blob (`audio-concat.ts`) — pass its blob URL straight in.
- Audio-upload mode: the uploaded file (mp3/wav/m4a) → pass directly, ffmpeg re-encodes to AAC.

Silent gaps between scenes are already baked into the master audio timing, so the video segments' durations match the audio automatically.

## Progress model

Total work units = (sum of frame counts across scenes) + (segments count for encode) + 2 (concat + mux). Report a single 0–1 fraction plus the current stage string.

## Out of scope

- Server-side rendering (would need a Worker with ffmpeg native, not available on Cloudflare).
- SharedArrayBuffer / multi-threaded ffmpeg core — the single-threaded core is enough at these bitrates and avoids the COOP/COEP header requirements which can conflict with the Lovable preview iframe.
- Changing the live in-browser `<VideoPlayer>` playback path. This plan only touches export.

## Files touched

- New: `src/lib/rasterize-scene.ts`, `src/lib/ffmpeg-stitcher.ts`
- Modified: `src/components/VideoPlayer.tsx` (call new exporter, update progress UI, `.mp4` filename)
- Modified: `package.json` (three new deps)
- Untouched: `src/lib/render-video.ts` kept as fallback for one cycle
