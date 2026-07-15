import { useLayoutEffect, useState } from "react";
import type { RevealCover } from "@/lib/build-reveal";

/** Box overlay preview — same layout as segment-lab (exact image aspect, % bboxes). */
export function ImageBBoxOverlay({
  imageUrl,
  covers,
  className = "",
}: {
  imageUrl: string;
  covers: RevealCover[];
  className?: string;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        setSize({ w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    img.src = imageUrl;
  }, [imageUrl]);

  if (!size) {
    return <div className={`min-h-32 bg-white ${className}`} />;
  }

  return (
    <div
      className={`relative mx-auto overflow-hidden bg-white ${className}`}
      style={{ width: "100%", aspectRatio: `${size.w} / ${size.h}` }}
    >
      <img
        src={imageUrl}
        alt=""
        className="absolute inset-0 h-full w-full"
        draggable={false}
      />
      {covers.map((c, i) => (
        <div
          key={c.id}
          className="pointer-events-none absolute rounded border-2 border-blue-500/85 bg-white/55"
          style={{
            left: `${c.bbox.x * 100}%`,
            top: `${c.bbox.y * 100}%`,
            width: `${c.bbox.w * 100}%`,
            height: `${c.bbox.h * 100}%`,
          }}
        >
          <span className="absolute left-0.5 top-0.5 rounded bg-blue-600 px-1 text-[10px] font-bold text-white">
            {i + 1}
          </span>
        </div>
      ))}
    </div>
  );
}
