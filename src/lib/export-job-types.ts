import type { Scene } from "@/components/VideoPlayer";
import type { ExportQuality } from "@/lib/export-rasterize";
import type { SceneBackground } from "@/lib/scene-background";
import type { PartBgmConfig } from "@/lib/part-bgm";

/** Pre-extracted looping video-bg frames (native export; avoids headless black frames). */
export interface ExportBackgroundFrames {
  /** Frame images relative to the export API, e.g. bgFrame query indices 1..count */
  count: number;
  fps: number;
  /** Duration of one loop in ms (count/fps*1000). */
  loopMs: number;
}

/** Pre-extracted screen-recording stills (one entry per unique mediaUrl). */
export interface ExportRecordingVideoFrames {
  mediaUrl: string;
  count: number;
  fps: number;
  durationMs: number;
}

/** Shared export job payload — safe for client + server (no Node imports). */
export interface ExportJobPayload {
  scenes: Scene[];
  masterAudioUrl?: string;
  quality: ExportQuality;
  background?: SceneBackground;
  /** When set, rasterizer uses these stills instead of seeking HTMLVideoElement. */
  backgroundFrames?: ExportBackgroundFrames;
  /** Screen-recording videos decoded to PNG stills for headless export. */
  recordingVideos?: ExportRecordingVideoFrames[];
  bgm?: PartBgmConfig | null;
  filename: string;
  /**
   * When set, the runner only rebuilds the audio track and remuxes onto a
   * previously cached silent video (smart re-export).
   */
  audioOnly?: boolean;
}
