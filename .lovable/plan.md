
# Script → Explainer Video (In-Browser)

Paste a script, get a synced explainer video: each sentence becomes a scene with a voiceover, an animated AI image or a Pexels clip, and a subtitle — played on a white-canvas timeline in the browser.

## User flow

1. Paste script → click **Generate**.
2. Backend chunks into sentences, plans each scene, and streams progress.
3. Per sentence, in parallel:
   - LLM decides `image` vs `stock` + writes an image prompt / Pexels query + subtitle.
   - If `image`: generate via Gemini/GPT-image (white background, illustrative).
   - If `stock`: search Pexels, pick top clip.
   - Generate ElevenLabs narration; measure duration → scene length.
4. When all scenes ready, custom `<VideoPlayer>` plays them on a white canvas: Ken Burns / fade / slide for images, muted playback for stock clips, synced audio + subtitle overlay, play/pause/scrub.

## Setup

- Enable **Lovable Cloud** (for secret storage + server functions).
- Store secrets via `add_secret`: `OPENAI_API_KEY`, `GEMINI_API_KEY` (optional if using OpenAI only), `ELEVENLABS_API_KEY`, `PEXELS_API_KEY`.
- One fixed narrator voice (ElevenLabs "Sarah" — `EXAVITQu4vr4xnSDxMaL`, `eleven_turbo_v2_5`, mp3).

## Architecture

Server functions (`src/lib/*.functions.ts`):
- `planScript` — split into sentences (regex + cleanup), then LLM call classifies each and returns `{ sentence, kind: 'image'|'stock', imagePrompt?, pexelsQuery?, subtitle }[]`.
- `generateImage` — OpenAI `gpt-image-1` (or Gemini), style: "flat illustration on pure white background". Returns base64/URL.
- `searchPexels` — hits `api.pexels.com/videos/search`, returns best portrait/landscape clip URL.
- `generateNarration` — ElevenLabs TTS, returns mp3 bytes + duration (probed with a tiny decode on client, or estimated at ~15 chars/sec server-side then corrected client-side via `<audio>.duration`).
- `generateVideo(script)` — orchestrates the above with `Promise.all`, returns full scene manifest.

Client (`src/routes/index.tsx`):
- Textarea + Generate button + progress list.
- `<VideoPlayer scenes={...}>`: single `<audio>` per scene played in sequence; a full-viewport white `<div>` shows the current image (with CSS `transform` Ken Burns keyframed by `requestAnimationFrame` against audio `currentTime`) or a muted `<video>` for stock. Subtitle bar at the bottom. Timeline scrubber and play/pause.

## Scene manifest shape

```ts
type Scene = {
  id: string;
  sentence: string;
  subtitle: string;
  kind: 'image' | 'stock';
  mediaUrl: string;      // image data URL or Pexels mp4
  audioUrl: string;      // mp3 data URL or blob URL
  durationMs: number;    // from audio
  animation: 'kenburns-in' | 'kenburns-out' | 'fade' | 'slide-left';
};
```

## Notes / limits

- No MP4 export in v1 — preview-only, as chosen.
- Long scripts: chunk TTS per sentence (already the design), cap script at ~40 sentences to keep API cost sane.
- Errors surfaced per scene (retry button on that scene) so one failed image doesn't kill the run.

## Open question

Do you want me to use **OpenAI (gpt-image-1) for images** or **Gemini (`gemini-2.5-flash-image`)**? Both work; Gemini is faster/cheaper, OpenAI tends toward crisper illustration. I'll default to Gemini unless you say otherwise.
