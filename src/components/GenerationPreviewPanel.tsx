import type { Scene } from "@/components/VideoPlayer";
import { ImageBBoxOverlay } from "@/components/ImageBBoxOverlay";
import type { RevealCover } from "@/lib/build-reveal";
import { boxRevealOpacityAtMs, revealSpeechDurationMs } from "@/lib/reveal-schedule";

const SOURCE_LABEL: Record<
  NonNullable<RevealCover["revealMatchSource"]>,
  { tag: string; className: string }
> = {
  speech: { tag: "speech", className: "text-green-700" },
  interpolated: { tag: "interpolated", className: "text-amber-700" },
  fixed: { tag: "fixed", className: "text-blue-700" },
  fallback: { tag: "fallback", className: "text-orange-700" },
};

export function GenerationPreviewPanel({
  scene,
  sceneIndex,
  playbackProgress,
  playbackElapsedMs,
}: {
  scene: Scene | null;
  sceneIndex: number;
  playbackProgress?: number;
  playbackElapsedMs?: number;
}) {
  if (!scene || scene.kind !== "image" || !scene.backgroundUrl) {
    return (
      <aside className="rounded-xl border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold">Generation preview</h3>
        <p className="text-xs text-muted-foreground">
          Generate a scene to see the composite image and detected reveal boxes here.
        </p>
      </aside>
    );
  }

  const covers = scene.revealCovers ?? [];
  const durationMs = revealSpeechDurationMs(scene);
  const elapsedMs =
    playbackElapsedMs ??
    (playbackProgress != null ? playbackProgress * durationMs : null);

  const speechMatched = covers.filter((c) => c.revealMatchSource === "speech").length;
  const unmatched = covers.filter(
    (c) => c.revealMatchSource === "interpolated" || c.revealMatchSource === "fallback",
  ).length;

  const coversBySpeechTime = covers
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        (a.c.revealStartMs ?? Number.MAX_SAFE_INTEGER) -
        (b.c.revealStartMs ?? Number.MAX_SAFE_INTEGER),
    );

  return (
    <aside className="sticky top-20 space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <h3 className="mb-1 text-sm font-semibold">Scene {sceneIndex + 1} — composite</h3>
        <p className="mb-3 text-xs text-muted-foreground">Full generated image</p>
        <div className="overflow-hidden rounded-lg border bg-white">
          <img
            src={scene.backgroundUrl}
            alt="Generated composite"
            className="block w-full object-contain"
          />
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h3 className="mb-1 text-sm font-semibold">
          Detected boxes ({covers.length})
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Reveal order follows speech time (not box number)
        </p>
        {covers.length > 0 && (
          <p
            className={`mb-3 text-[11px] ${
              unmatched > covers.length / 2 ? "text-amber-700 font-medium" : "text-muted-foreground"
            }`}
          >
            Match audit: {speechMatched}/{covers.length} speech-matched
            {unmatched > 0 ? ` · ${unmatched} interpolated/fallback` : ""}
          </p>
        )}
        {covers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No boxes detected yet.</p>
        ) : (
          <>
            <ImageBBoxOverlay
              imageUrl={scene.backgroundUrl}
              covers={covers}
              className="rounded-lg border"
            />
            <ol className="mt-3 max-h-52 space-y-1 overflow-y-auto text-[11px] text-muted-foreground">
              {coversBySpeechTime.map(({ c, i }) => {
                const opacity =
                  elapsedMs != null ? boxRevealOpacityAtMs(elapsedMs, i, covers) : null;
                const active = opacity != null && opacity > 0 && opacity < 1;
                const revealed = opacity != null && opacity >= 1;
                const startLabel =
                  c.revealStartMs != null
                    ? `@${(c.revealStartMs / 1000).toFixed(1)}s`
                    : "";
                const source = c.revealMatchSource
                  ? SOURCE_LABEL[c.revealMatchSource]
                  : null;
                const phrase = c.revealMatchPhrase?.trim();
                return (
                  <li
                    key={c.id}
                    className={`rounded px-2 py-0.5 ${
                      active
                        ? "bg-primary/10 text-primary font-medium"
                        : revealed
                          ? "text-green-700"
                          : ""
                    }`}
                  >
                    {i + 1}. {c.role ? `[${c.role}] ` : ""}
                    {c.label ?? `box ${i + 1}`}
                    {source && (
                      <span className={` ml-1 font-medium ${source.className}`}>
                        [{source.tag}]
                      </span>
                    )}
                    {phrase && phrase !== c.label && (
                      <span className="ml-1 text-muted-foreground">“{phrase}”</span>
                    )}
                    {startLabel && <span className="ml-1">· {startLabel}</span>}
                    {active && " · revealing…"}
                    {revealed && " · shown"}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </aside>
  );
}
