import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EXCALIFONT_STACK, ensureExcalifontLoaded } from "@/lib/scene-font";
import {
  TEMPLATE_REF_HEIGHT,
  templateCountdownDurationMs,
  templateCountdownRemaining,
  templateTypingComplete,
  templateTypingVisibleText,
} from "@/lib/template-scene-canvas";
import type { Scene } from "@/components/VideoPlayer";

function wrapCssLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** Live preview of white-bg Excalifont text / typing / countdown templates. */
export function TemplateScene({
  scene,
  progress,
  elapsedMs,
}: {
  scene: Scene;
  progress: number;
  /** When set (countdown), drives the tick instead of progress × full scene length. */
  elapsedMs?: number;
}) {
  const kind =
    scene.templateKind === "countdown"
      ? "countdown"
      : scene.templateKind === "typing"
        ? "typing"
        : "text";
  const color = scene.templateColor || "#1a1a1a";
  const fontSizeRef = scene.templateFontSize ?? (kind === "countdown" ? 160 : 72);
  const text = scene.templateText ?? "";
  const countdownSec = Math.max(1, Math.round(scene.templateCountdownSec ?? 5));
  const countdownMs = templateCountdownDurationMs(countdownSec);
  const tickElapsed =
    kind === "countdown"
      ? (elapsedMs ?? progress * countdownMs)
      : 0;
  const numberLabel =
    kind === "countdown"
      ? String(templateCountdownRemaining(tickElapsed, countdownSec))
      : "";
  const typingFull = text.trim() || "Your text here";
  const typingVisible =
    kind === "typing" ? templateTypingVisibleText(typingFull, progress) : "";
  const showCaret =
    kind === "typing" && !templateTypingComplete(typingFull, progress);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    void ensureExcalifontLoaded();
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const h = el.clientHeight;
      if (h > 0) setScale(h / TEMPLATE_REF_HEIGHT);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fontPx = Math.max(16, Math.round(fontSizeRef * scale));
  const labelPx = Math.max(18, Math.round(fontPx * 0.28));

  return (
    <div ref={containerRef} className="absolute inset-0 flex flex-col items-center justify-center bg-white px-[8%]">
      {kind === "countdown" ? (
        <>
          {text.trim() ? (
            <p
              className="mb-6 max-w-full whitespace-pre-wrap text-center leading-snug"
              style={{
                fontFamily: EXCALIFONT_STACK,
                color,
                fontSize: labelPx,
                fontWeight: 600,
              }}
            >
              {wrapCssLines(text).join("\n")}
            </p>
          ) : null}
          <p
            className="tabular-nums leading-none"
            style={{
              fontFamily: EXCALIFONT_STACK,
              color,
              fontSize: fontPx,
              fontWeight: 700,
            }}
          >
            {numberLabel}
          </p>
        </>
      ) : kind === "typing" ? (
        <p
          className="max-w-full whitespace-pre-wrap text-center leading-snug"
          style={{
            fontFamily: EXCALIFONT_STACK,
            color,
            fontSize: fontPx,
            fontWeight: 600,
          }}
        >
          {wrapCssLines(typingVisible || "\u00a0").join("\n")}
          {showCaret ? (
            <span
              aria-hidden
              className="ml-0.5 inline-block align-baseline"
              style={{
                width: Math.max(2, fontPx * 0.12),
                height: fontPx * 0.9,
                background: color,
                opacity: 0.85,
              }}
            />
          ) : null}
        </p>
      ) : (
        <p
          className="max-w-full whitespace-pre-wrap text-center leading-snug"
          style={{
            fontFamily: EXCALIFONT_STACK,
            color,
            fontSize: fontPx,
            fontWeight: 600,
          }}
        >
          {wrapCssLines(text.trim() || "Your text here").join("\n")}
        </p>
      )}
    </div>
  );
}
