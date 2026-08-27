import type { Scene } from "@/components/VideoPlayer";
import type { PartBgmConfig } from "@/lib/part-bgm";
import type { PartTransitionConfig } from "@/lib/part-transition";
import type { PartScriptScene } from "@/lib/part-script";

export interface ProjectPart {
  id: string;
  title: string;
  scenes: Scene[];
  masterAudioUrl: string;
  durationMs: number;
  /** Flattened part script (legacy + searchable). */
  script?: string;
  /** Structured scene scripts from the Script tab. */
  scriptScenes?: PartScriptScene[];
  /** Continuous background music for this part (preview + export). */
  bgm?: PartBgmConfig;
  /** Default inter-scene transition (used when a gap has no own config). */
  transition?: PartTransitionConfig;
  /** Per-gap transitions between scenes (length = scenes.length - 1). */
  transitions?: PartTransitionConfig[];
  thumbnail_url?: string | null;
  /** Collaborator assigned to this part (admin handoff). */
  assignedUserId?: string | null;
  assignedUserEmail?: string | null;
  /** Reviewer assigned to this part (admin handoff). */
  reviewerUserId?: string | null;
  reviewerUserEmail?: string | null;
  created_at: string;
  updated_at: string;
}

type ProjectLike = {
  parts?: unknown;
  workshop_draft?: unknown;
};

export function getProjectParts(project: ProjectLike | null | undefined): ProjectPart[] {
  if (!project) return [];
  if (Array.isArray(project.parts)) {
    return project.parts.filter(isProjectPart);
  }
  const wd = project.workshop_draft;
  if (wd && typeof wd === "object" && wd !== null && "composeParts" in wd) {
    const raw = (wd as { composeParts?: unknown }).composeParts;
    if (Array.isArray(raw)) return raw.filter(isProjectPart);
  }
  return [];
}

function isProjectPart(v: unknown): v is ProjectPart {
  if (!v || typeof v !== "object") return false;
  const p = v as ProjectPart;
  return (
    typeof p.id === "string" &&
    typeof p.title === "string" &&
    Array.isArray(p.scenes) &&
    typeof p.masterAudioUrl === "string"
  );
}

export function defaultPartTitle(existing: ProjectPart[]): string {
  return `Part ${existing.length + 1}`;
}

export function partThumb(part: ProjectPart): string | undefined {
  const s = part.scenes[0];
  if (!s) return part.thumbnail_url ?? undefined;
  return s.compositeThumbUrl ?? s.backgroundUrl ?? s.elements?.[0]?.mediaUrl ?? part.thumbnail_url ?? undefined;
}

/** Unique collaborator emails working on parts (excluding empty). */
export function partAssigneeEmails(parts: ProjectPart[]): string[] {
  const emails = new Set<string>();
  for (const p of parts) {
    const email = p.assignedUserEmail?.trim();
    if (email) emails.add(email);
  }
  return [...emails].sort((a, b) => a.localeCompare(b));
}

export function partAssignedToUser(part: ProjectPart, userId: string): boolean {
  return !!part.assignedUserId && part.assignedUserId === userId;
}

export function partAssignedToEmail(
  part: ProjectPart,
  userEmail: string,
): boolean {
  const email = part.assignedUserEmail?.trim().toLowerCase();
  const needle = userEmail.trim().toLowerCase();
  return !!email && !!needle && email === needle;
}

/** True when this user may mutate the part's scenes/script (assignee, or elevated). */
export function userCanEditPart(
  part: ProjectPart,
  user: { userId: string; userEmail: string },
  opts?: { asAdmin?: boolean; isOwner?: boolean },
): boolean {
  if (opts?.asAdmin || opts?.isOwner) return true;
  if (partAssignedToUser(part, user.userId)) return true;
  if (partAssignedToEmail(part, user.userEmail)) return true;
  return false;
}

/** Worker or reviewer (or elevated) may open the part. */
export function userCanAccessPart(
  part: ProjectPart,
  user: { userId: string; userEmail: string },
  opts?: { asAdmin?: boolean; isOwner?: boolean },
): boolean {
  if (userCanEditPart(part, user, opts)) return true;
  const reviewerId = (part as { reviewerUserId?: string | null }).reviewerUserId;
  const reviewerEmail = (part as { reviewerUserEmail?: string | null }).reviewerUserEmail?.trim().toLowerCase();
  if (reviewerId && reviewerId === user.userId) return true;
  if (reviewerEmail && reviewerEmail === user.userEmail.trim().toLowerCase()) return true;
  return false;
}

function sceneIdOf(scene: unknown): string | null {
  if (!scene || typeof scene !== "object") return null;
  const id = (scene as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : null;
}

/**
 * Keep any DB scenes that a stale client omitted, unless the client explicitly
 * allowed a shrink (user clicked Delete scene).
 */
export function mergePartScenesPreserving(
  existingScenes: unknown,
  incomingScenes: unknown,
  allowShrink: boolean,
): unknown[] {
  const existing = Array.isArray(existingScenes) ? existingScenes : [];
  const incoming = Array.isArray(incomingScenes) ? incomingScenes : [];
  if (allowShrink) return incoming;
  if (incoming.length === 0 && existing.length > 0) return existing;

  const incomingIds = new Set(
    incoming.map(sceneIdOf).filter((id): id is string => !!id),
  );
  const preserved = existing.filter((s) => {
    const id = sceneIdOf(s);
    return id != null && !incomingIds.has(id);
  });
  return preserved.length === 0 ? incoming : [...incoming, ...preserved];
}

/**
 * Collaborative save merge: keep DB parts the saver cannot edit, apply incoming
 * only for parts they own/are assigned to. Prevents Sai's stale Part-1 copy from
 * wiping Manish's scenes (and the reverse).
 */
export function mergePartsForCollaborativeSave(opts: {
  existingParts: ProjectPart[];
  incomingParts: unknown;
  userId: string;
  userEmail: string;
  asAdmin?: boolean;
  isOwner?: boolean;
  now?: string;
  /** When true, missing scene ids are treated as intentional deletes. */
  allowSceneShrink?: boolean;
  /** Script-only autosaves must never replace a newer scene payload. */
  preserveScenes?: boolean;
}): ProjectPart[] {
  const existing = opts.existingParts;
  const incoming = getProjectParts({ parts: opts.incomingParts });
  const incomingById = new Map(incoming.map((p) => [p.id, p]));
  const now = opts.now ?? new Date().toISOString();
  const elevated = opts.asAdmin === true || opts.isOwner === true;
  const allowSceneShrink = opts.allowSceneShrink === true;

  const merged = existing.map((ep) => {
    const ip = incomingById.get(ep.id);
    if (!ip) return ep;
    if (
      !userCanEditPart(ep, { userId: opts.userId, userEmail: opts.userEmail }, {
        asAdmin: opts.asAdmin,
        isOwner: opts.isOwner,
      })
    ) {
      return ep;
    }

    // Scene saves may legitimately start from an older part snapshot after a
    // large asset upload. Merge them by scene id instead of silently dropping
    // the edit based on client wall-clock timestamps. Script-only autosaves
    // explicitly preserve the latest DB scene payload.
    const scenes = opts.preserveScenes
      ? ep.scenes
      : (mergePartScenesPreserving(
          ep.scenes,
          ip.scenes,
          allowSceneShrink,
        ) as ProjectPart["scenes"]);

    return {
      ...ip,
      scenes,
      assignedUserId: ep.assignedUserId,
      assignedUserEmail: ep.assignedUserEmail,
      created_at: ep.created_at || ip.created_at,
      updated_at: now,
    };
  });

  // Only owners/admins may append brand-new parts or delete parts via a full save.
  if (elevated) {
    const existingIds = new Set(existing.map((p) => p.id));
    const incomingIds = new Set(incoming.map((p) => p.id));
    for (const ip of incoming) {
      if (!existingIds.has(ip.id)) merged.push(ip);
    }
    if (incoming.length > 0 && incoming.length < existing.length) {
      return merged.filter((p) => incomingIds.has(p.id));
    }
  }

  return merged;
}
