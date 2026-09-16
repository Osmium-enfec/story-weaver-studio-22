import type { VoiceEngine } from "@/lib/course-voice";
import { voiceEngineForCourseName } from "@/lib/course-voice";

export type CourseBackgroundPreset = "video-loop" | "plain-white";

/**
 * Per-course theme: background loop, brand bumpers and narration voice.
 * Stored on the course row so every episode/part of that course inherits it.
 */
export interface CourseSettings {
  backgroundPreset: CourseBackgroundPreset;
  /** Custom looping background video (null = built-in loop). */
  bgLoopUrl: string | null;
  /** Custom intro bumper (null = shared brand intro). */
  introUrl: string | null;
  introDurationMs: number | null;
  /** Custom outro bumper (null = shared brand outro). */
  outroUrl: string | null;
  outroDurationMs: number | null;
  /** null = derive from the course name (legacy behaviour). */
  voiceEngine: VoiceEngine | null;
}

export const DEFAULT_COURSE_SETTINGS: CourseSettings = {
  backgroundPreset: "video-loop",
  bgLoopUrl: null,
  introUrl: null,
  introDurationMs: null,
  outroUrl: null,
  outroDurationMs: null,
  voiceEngine: null,
};

function str(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function normalizeCourseSettings(raw: unknown): CourseSettings {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    backgroundPreset: o.backgroundPreset === "plain-white" ? "plain-white" : "video-loop",
    bgLoopUrl: str(o.bgLoopUrl),
    introUrl: str(o.introUrl),
    introDurationMs: num(o.introDurationMs),
    outroUrl: str(o.outroUrl),
    outroDurationMs: num(o.outroDurationMs),
    voiceEngine:
      o.voiceEngine === "kokoro" || o.voiceEngine === "elevenlabs"
        ? o.voiceEngine
        : null,
  };
}

/** Effective voice for a course (explicit setting wins over the name rule). */
export function resolveCourseVoiceEngine(
  settings: CourseSettings | null | undefined,
  courseTitle?: string | null,
): VoiceEngine {
  return settings?.voiceEngine ?? voiceEngineForCourseName(courseTitle);
}

export const VOICE_ENGINE_OPTIONS: {
  id: VoiceEngine;
  label: string;
  description: string;
}[] = [
  {
    id: "elevenlabs",
    label: "Liam (ElevenLabs)",
    description: "Server voice — natural, needs the narration service",
  },
  {
    id: "kokoro",
    label: "Heart (Kokoro)",
    description: "Runs on the editor's own machine, no service needed",
  },
];
