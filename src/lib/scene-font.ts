/** Hand-drawn scene text — matches Excalidraw's Excalifont. */
export const EXCALIFONT_FAMILY = "Excalifont";

export const EXCALIFONT_STACK = `${EXCALIFONT_FAMILY}, cursive`;

export function canvasFont(weight: number | string, sizePx: number): string {
  return `${weight} ${Math.round(sizePx)}px ${EXCALIFONT_STACK}`;
}

let loadPromise: Promise<void> | null = null;

/** Ensure Excalifont is ready before canvas text measurement / export. */
export function ensureExcalifontLoaded(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (!document.fonts?.load) return;
    await Promise.all([
      document.fonts.load(`400 24px ${EXCALIFONT_FAMILY}`),
      document.fonts.load(`700 24px ${EXCALIFONT_FAMILY}`),
    ]);
    await document.fonts.ready;
  })();
  return loadPromise;
}
