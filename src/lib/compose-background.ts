import {
  DEFAULT_BACKGROUND,
  LOOP_VIDEO_BACKGROUND,
  type SceneBackground,
} from "@/lib/scene-background";
import { getActiveCourseMedia } from "@/lib/course-media";

export type ComposeBackgroundPreset = "video-loop" | "plain-white";

export const COMPOSE_BACKGROUND_PRESETS: {
  id: ComposeBackgroundPreset;
  label: string;
  description: string;
  background: SceneBackground;
}[] = [
  {
    id: "video-loop",
    label: "Video loop",
    description: "Looping background with a white content card",
    background: LOOP_VIDEO_BACKGROUND,
  },
  {
    id: "plain-white",
    label: "Plain white",
    description: "Full-frame white canvas (no video behind)",
    background: { kind: "whiteboard" },
  },
];

export function presetFromBackground(bg: SceneBackground): ComposeBackgroundPreset {
  if (bg.kind === "video") return "video-loop";
  return "plain-white";
}

export function backgroundFromPreset(id: ComposeBackgroundPreset): SceneBackground {
  const base =
    COMPOSE_BACKGROUND_PRESETS.find((p) => p.id === id)?.background ?? DEFAULT_BACKGROUND;
  if (base.kind === "video") {
    const { bgLoopUrl } = getActiveCourseMedia();
    if (bgLoopUrl) return { kind: "video", url: bgLoopUrl };
  }
  return base;
}
