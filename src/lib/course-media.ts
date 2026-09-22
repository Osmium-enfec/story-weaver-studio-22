import { DEFAULT_COURSE_SETTINGS, type CourseSettings } from "@/lib/course-settings";
import type { TemplateTheme } from "@/lib/template-theme";

/**
 * Media overrides for the course currently open in the editor.
 *
 * Background loop and intro/outro bumpers are course-level theme, but they are
 * consumed deep inside scene builders (`common-intro-outro`, `scene-background`)
 * that have no course context. The compose page publishes the active course's
 * settings here once, and those builders read them.
 */
export interface ActiveCourseMedia {
  bgLoopUrl: string | null;
  introUrl: string | null;
  introDurationMs: number | null;
  outroUrl: string | null;
  outroDurationMs: number | null;
  templateTheme: TemplateTheme | null;
}

const EMPTY: ActiveCourseMedia = {
  bgLoopUrl: null,
  introUrl: null,
  introDurationMs: null,
  outroUrl: null,
  outroDurationMs: null,
  templateTheme: null,
};

let active: ActiveCourseMedia = EMPTY;

export function setActiveCourseMedia(
  settings: CourseSettings | null | undefined,
): void {
  const s = settings ?? DEFAULT_COURSE_SETTINGS;
  active = {
    bgLoopUrl: s.bgLoopUrl,
    introUrl: s.introUrl,
    introDurationMs: s.introDurationMs,
    outroUrl: s.outroUrl,
    outroDurationMs: s.outroDurationMs,
    templateTheme: s.templateTheme,
  };
}

export function clearActiveCourseMedia(): void {
  active = EMPTY;
}

export function getActiveCourseMedia(): ActiveCourseMedia {
  return active;
}
