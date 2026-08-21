/**
 * LAN work sync: admin pushes assignments; collaborators pull them and send
 * part-owned work back (LAN submit or return-zip fallback).
 *
 * Conflict model: part ownership only — one assignee per part, so merges never
 * touch another person's scenes.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hostDataRoot, hostProjectAssetsRoot } from "@/lib/host-storage";
import {
  localGetProjectById,
  localListAllProjects,
} from "@/lib/local-projects-db";
import {
  localGetCourseById,
  type LocalCourseRow,
} from "@/lib/local-courses-db";
import {
  getProjectParts,
  mergePartsForCollaborativeSave,
  partAssignedToEmail,
  partAssignedToUser,
  userCanAccessPart,
  type ProjectPart,
} from "@/lib/project-parts";
import { putAsset } from "@/lib/object-storage";

export const SYNC_SCHEMA = 1 as const;
export const PYTHON_FOR_AI_COURSE_ID =
  "b27f9873-b549-496f-9c21-b86fadf548d6";

export type SyncEpisodeSnapshot = {
  id: string;
  title: string;
  script: string | null;
  audio_mode: string;
  scenes: unknown;
  parts: ProjectPart[];
  thumbnail_url: string | null;
  course_id: string | null;
  user_id: string;
  assigned_user_id: string | null;
  assigned_user_email: string | null;
  created_at: string;
  updated_at: string;
};

export type AssignmentsSnapshot = {
  schema: typeof SYNC_SCHEMA;
  kind: "assignments";
  pushedAt: string;
  pushedByEmail: string;
  course?: LocalCourseRow;
  episodes: SyncEpisodeSnapshot[];
  assets?: SyncAssetManifestItem[];
  missingAssets?: string[];
  scopedTo?: { userId: string; email: string };
};

export type SyncAssetManifestItem = {
  rel: string;
  size: number;
  sha256: string;
};

export type WorkAsset = {
  /** Relative under project-assets, e.g. userId/episodeId/file.ext */
  rel: string;
  /** Base64 file bytes */
  data: string;
};

export type WorkSubmissionPart = {
  episodeId: string;
  episodeTitle: string;
  courseId: string | null;
  ownerUserId: string;
  part: ProjectPart;
};

export type WorkSubmission = {
  schema: typeof SYNC_SCHEMA;
  kind: "work";
  submittedAt: string;
  submitterUserId: string;
  submitterEmail: string;
  parts: WorkSubmissionPart[];
  assets: WorkAsset[];
};

export type InboxEntry = {
  id: string;
  receivedAt: string;
  status: "pending" | "merged" | "rejected";
  submitterEmail: string;
  submitterUserId: string;
  partCount: number;
  episodeTitles: string[];
  packagePath: string;
};

function syncRoot() {
  return path.join(hostDataRoot(), "sync");
}

export function assignmentsSnapshotPath() {
  return path.join(syncRoot(), "assignments-latest.json");
}

function inboxDir() {
  return path.join(syncRoot(), "inbox");
}

function collectAssetRelPaths(value: unknown, out: Set<string>) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\/api\/assets\/[^"'\\\s)]+/g)) {
      const raw = match[0].split("/api/assets/")[1].split(/[?#]/)[0];
      try {
        out.add(decodeURIComponent(raw));
      } catch {
        out.add(raw);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAssetRelPaths(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectAssetRelPaths(item, out);
  }
}

function readAssetBase64(rel: string): string | null {
  const full = path.join(hostProjectAssetsRoot(), rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return fs.readFileSync(full).toString("base64");
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function buildAssetManifest(assetRels: Set<string>): Promise<{
  assets: SyncAssetManifestItem[];
  missingAssets: string[];
}> {
  const assets: SyncAssetManifestItem[] = [];
  const missingAssets: string[] = [];
  for (const rel of [...assetRels].sort()) {
    const full = path.join(hostProjectAssetsRoot(), rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      missingAssets.push(rel);
      continue;
    }
    const stat = fs.statSync(full);
    assets.push({
      rel,
      size: stat.size,
      sha256: await sha256File(full),
    });
  }
  return { assets, missingAssets };
}

/**
 * Build current Python for AI data from the canonical admin DB.
 * When viewer is supplied, only parts that viewer may access are exposed.
 */
export async function buildAssignmentsSnapshot(
  pushedByEmail: string,
  viewer?: { userId: string; email: string },
): Promise<AssignmentsSnapshot> {
  const course = (await localGetCourseById(
    PYTHON_FOR_AI_COURSE_ID,
  )) as LocalCourseRow | null;
  if (!course) throw new Error("Python for AI course is missing from the main database.");

  const list = await localListAllProjects();
  const episodes: SyncEpisodeSnapshot[] = [];
  const assetRels = new Set<string>();
  collectAssetRelPaths(course, assetRels);

  for (const item of list) {
    const row = await localGetProjectById(item.id);
    if (!row) continue;
    if (row.course_id !== PYTHON_FOR_AI_COURSE_ID) continue;
    const parts = getProjectParts(row);
    const assignedParts = parts.filter(
      (p) => p.assignedUserId || p.assignedUserEmail || p.reviewerUserId || p.reviewerUserEmail,
    );
    const snapshotParts = viewer
      ? assignedParts.filter((part) =>
          userCanAccessPart(part, {
            userId: viewer.userId,
            userEmail: viewer.email,
          }),
        )
      : assignedParts;
    if (!snapshotParts.length) continue;

    const episode: SyncEpisodeSnapshot = {
      id: row.id,
      title: row.title,
      script: row.script ?? null,
      audio_mode: row.audio_mode,
      scenes: row.scenes ?? [],
      parts: snapshotParts,
      thumbnail_url: row.thumbnail_url ?? null,
      course_id: row.course_id ?? null,
      user_id: row.user_id,
      assigned_user_id: row.assigned_user_id ?? null,
      assigned_user_email: row.assigned_user_email ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    episodes.push(episode);
    collectAssetRelPaths(
      {
        thumbnail_url: episode.thumbnail_url,
        scenes: episode.scenes,
        parts: snapshotParts,
      },
      assetRels,
    );
  }

  const manifest = await buildAssetManifest(assetRels);
  return {
    schema: SYNC_SCHEMA,
    kind: "assignments",
    pushedAt: new Date().toISOString(),
    pushedByEmail,
    course,
    episodes,
    ...manifest,
    ...(viewer
      ? { scopedTo: { userId: viewer.userId, email: viewer.email } }
      : {}),
  };
}

export function writeAssignmentsSnapshot(snapshot: AssignmentsSnapshot) {
  const dir = syncRoot();
  fs.mkdirSync(dir, { recursive: true });
  const file = assignmentsSnapshotPath();
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
  return file;
}

export function readAssignmentsSnapshot(): AssignmentsSnapshot | null {
  const file = assignmentsSnapshotPath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as AssignmentsSnapshot;
    if (raw?.kind !== "assignments" || !Array.isArray(raw.episodes)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Download only changed canonical assets and verify every transfer by SHA-256. */
export async function syncSnapshotAssets(
  snapshot: AssignmentsSnapshot,
  origin: string,
): Promise<{ assetsDownloaded: number; assetsCurrent: number; assetsFailed: string[] }> {
  let assetsDownloaded = 0;
  let assetsCurrent = 0;
  const assetsFailed: string[] = [];

  for (const asset of snapshot.assets ?? []) {
    const rel = String(asset.rel || "").replace(/^\/+/, "");
    if (!rel || rel.includes("..")) {
      assetsFailed.push(rel || "(invalid path)");
      continue;
    }
    const local = path.join(hostProjectAssetsRoot(), rel);
    if (
      fs.existsSync(local) &&
      fs.statSync(local).isFile() &&
      fs.statSync(local).size === asset.size &&
      (await sha256File(local)) === asset.sha256
    ) {
      assetsCurrent++;
      continue;
    }

    const url = `${origin.replace(/\/+$/, "")}/api/assets/${rel
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const hash = createHash("sha256").update(body).digest("hex");
      if (body.length !== asset.size || hash !== asset.sha256) {
        throw new Error("checksum mismatch");
      }
      await putAsset({ kind: "project", relPath: rel, body });
      assetsDownloaded++;
    } catch {
      assetsFailed.push(rel);
    }
  }

  return { assetsDownloaded, assetsCurrent, assetsFailed };
}

/**
 * Apply an admin assignment snapshot onto this machine's projects.db.
 * - Assignment / reviewer fields always come from admin.
 * - Local scene content for parts I own is preserved (my work stays).
 * - Parts I don't own take admin content.
 * - Missing episodes/parts are created.
 */
export async function applyAssignmentsSnapshot(
  snapshot: AssignmentsSnapshot,
  viewer: { userId: string; userEmail: string },
): Promise<{
  episodesTouched: number;
  partsAssignedToMe: number;
  partsPreserved: number;
}> {
  const { applySyncedEpisode } = await import("@/lib/local-projects-db");
  if (snapshot.course) {
    const { applySyncedCourse } = await import("@/lib/local-courses-db");
    await applySyncedCourse(snapshot.course);
  }
  let episodesTouched = 0;
  let partsAssignedToMe = 0;
  let partsPreserved = 0;

  for (const ep of snapshot.episodes) {
    const existing = await localGetProjectById(ep.id);
    const incomingParts = getProjectParts(ep);
    const mine = incomingParts.filter((p) =>
      userCanAccessPart(p, {
        userId: viewer.userId,
        userEmail: viewer.userEmail,
      }),
    );
    partsAssignedToMe += mine.length;

    if (!existing) {
      // Only create locally if this user has a stake, or they're pulling as admin.
      const relevant =
        mine.length > 0 ||
        ep.user_id === viewer.userId ||
        (ep.assigned_user_id && ep.assigned_user_id === viewer.userId);
      if (!relevant) continue;
      await applySyncedEpisode({
        episode: ep,
        parts: incomingParts,
        isNew: true,
      });
      episodesTouched++;
      continue;
    }

    const localParts = getProjectParts(existing);
    const localById = new Map(localParts.map((p) => [p.id, p]));
    const merged: ProjectPart[] = [];
    const seen = new Set<string>();

    for (const adminPart of incomingParts) {
      seen.add(adminPart.id);
      const local = localById.get(adminPart.id);
      const iOwnLocal =
        local &&
        (partAssignedToUser(local, viewer.userId) ||
          partAssignedToEmail(local, viewer.userEmail) ||
          partAssignedToUser(adminPart, viewer.userId) ||
          partAssignedToEmail(adminPart, viewer.userEmail));

      if (local && iOwnLocal) {
        // Keep my scenes/script; take admin assignment fields.
        partsPreserved++;
        merged.push({
          ...local,
          title: adminPart.title || local.title,
          assignedUserId: adminPart.assignedUserId ?? null,
          assignedUserEmail: adminPart.assignedUserEmail ?? null,
          reviewerUserId: adminPart.reviewerUserId ?? null,
          reviewerUserEmail: adminPart.reviewerUserEmail ?? null,
        });
      } else if (local) {
        // Not my part — refresh from admin (structure / others' stubs).
        merged.push({
          ...adminPart,
          // If I somehow had local edits as reviewer-only, prefer admin content.
        });
      } else {
        merged.push(adminPart);
      }
    }

    // Keep any local-only parts that aren't in the admin snapshot (shouldn't
    // happen often; preserve just in case).
    for (const lp of localParts) {
      if (!seen.has(lp.id)) merged.push(lp);
    }

    await applySyncedEpisode({
      episode: {
        ...ep,
        // Keep local ownership of the row; don't steal user_id.
        user_id: existing.user_id,
        // Episode-level scenes are legacy; don't clobber local.
        scenes: existing.scenes ?? ep.scenes,
        script: existing.script ?? ep.script,
      },
      parts: merged,
      isNew: false,
    });
    episodesTouched++;
  }

  return { episodesTouched, partsAssignedToMe, partsPreserved };
}

/** Package every part this user is assigned to (worker), plus referenced assets. */
export async function buildWorkSubmission(user: {
  userId: string;
  email: string;
}): Promise<WorkSubmission> {
  const list = await localListAllProjects();
  const parts: WorkSubmissionPart[] = [];
  const assetRels = new Set<string>();

  for (const item of list) {
    const row = await localGetProjectById(item.id);
    if (!row) continue;
    if (row.course_id !== PYTHON_FOR_AI_COURSE_ID) continue;
    for (const part of getProjectParts(row)) {
      if (
        !partAssignedToUser(part, user.userId) &&
        !partAssignedToEmail(part, user.email)
      ) {
        continue;
      }
      parts.push({
        episodeId: row.id,
        episodeTitle: row.title,
        courseId: row.course_id ?? null,
        ownerUserId: row.user_id,
        part,
      });
      collectAssetRelPaths(part, assetRels);
    }
  }

  const assets: WorkAsset[] = [];
  for (const rel of assetRels) {
    const data = readAssetBase64(rel);
    if (data) assets.push({ rel, data });
  }

  return {
    schema: SYNC_SCHEMA,
    kind: "work",
    submittedAt: new Date().toISOString(),
    submitterUserId: user.userId,
    submitterEmail: user.email,
    parts,
    assets,
  };
}

export function saveSubmissionToInbox(submission: WorkSubmission): InboxEntry {
  fs.mkdirSync(inboxDir(), { recursive: true });
  const id = randomUUID();
  const packagePath = path.join(inboxDir(), `${id}.json`);
  fs.writeFileSync(packagePath, JSON.stringify(submission, null, 2) + "\n");

  const meta: InboxEntry = {
    id,
    receivedAt: new Date().toISOString(),
    status: "pending",
    submitterEmail: submission.submitterEmail,
    submitterUserId: submission.submitterUserId,
    partCount: submission.parts.length,
    episodeTitles: [...new Set(submission.parts.map((p) => p.episodeTitle))],
    packagePath,
  };
  fs.writeFileSync(
    path.join(inboxDir(), `${id}.meta.json`),
    JSON.stringify(meta, null, 2) + "\n",
  );
  return meta;
}

export function listInbox(): InboxEntry[] {
  const dir = inboxDir();
  if (!fs.existsSync(dir)) return [];
  const out: InboxEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, name), "utf8"),
      ) as InboxEntry;
      out.push(meta);
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

function readInboxPackage(id: string): { meta: InboxEntry; submission: WorkSubmission } {
  const metaPath = path.join(inboxDir(), `${id}.meta.json`);
  if (!fs.existsSync(metaPath)) throw new Error("Submission not found.");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as InboxEntry;
  const pkgPath = meta.packagePath || path.join(inboxDir(), `${id}.json`);
  if (!fs.existsSync(pkgPath)) throw new Error("Submission package missing.");
  const submission = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as WorkSubmission;
  if (submission.kind !== "work") throw new Error("Invalid work package.");
  return { meta, submission };
}

function writeInboxMeta(meta: InboxEntry) {
  fs.writeFileSync(
    path.join(inboxDir(), `${meta.id}.meta.json`),
    JSON.stringify(meta, null, 2) + "\n",
  );
}

/** Merge a pending submission into the admin master DB by part ownership. */
export async function mergeInboxSubmission(id: string): Promise<{
  mergedParts: number;
  assetsWritten: number;
}> {
  const { applySubmitterParts } = await import("@/lib/local-projects-db");
  const { meta, submission } = readInboxPackage(id);
  if (meta.status === "merged") {
    return { mergedParts: 0, assetsWritten: 0 };
  }

  // Validate the complete package before writing either DB rows or assets.
  const byEpisode = new Map<string, ProjectPart[]>();
  const seenParts = new Set<string>();
  for (const item of submission.parts) {
    const admin = await localGetProjectById(item.episodeId);
    if (!admin) {
      throw new Error(
        `Episode “${item.episodeTitle}” (${item.episodeId}) is missing on this Mac. Pull/import the course first.`,
      );
    }
    if (admin.course_id !== PYTHON_FOR_AI_COURSE_ID) {
      throw new Error("Only Python for AI work may be submitted to the main database.");
    }
    const existingParts = getProjectParts(admin);
    const target = existingParts.find((p) => p.id === item.part.id);
    if (!target) {
      throw new Error(
        `Part “${item.part.title}” is not on episode “${item.episodeTitle}”. Push assignments from admin first.`,
      );
    }
    // Ownership check against admin's current assignment (source of truth).
    const allowed =
      partAssignedToUser(target, submission.submitterUserId) ||
      partAssignedToEmail(target, submission.submitterEmail);
    if (!allowed) {
      throw new Error(
        `“${submission.submitterEmail}” is not assigned to part “${item.part.title}”.`,
      );
    }
    const key = `${item.episodeId}:${item.part.id}`;
    if (seenParts.has(key)) {
      throw new Error(`Part “${item.part.title}” appears more than once in the package.`);
    }
    seenParts.add(key);
    const incomingUpdated = Date.parse(String(item.part.updated_at || ""));
    const mainUpdated = Date.parse(String(target.updated_at || ""));
    if (
      Number.isFinite(incomingUpdated) &&
      Number.isFinite(mainUpdated) &&
      incomingUpdated < mainUpdated
    ) {
      throw new Error(
        `The main database has a newer version of part “${item.part.title}”. ` +
          "Your local work was not overwritten or merged; get latest data and ask the admin before retrying.",
      );
    }
    const list = byEpisode.get(item.episodeId) || [];
    list.push(item.part);
    byEpisode.set(item.episodeId, list);
  }

  let assetsWritten = 0;
  for (const asset of submission.assets || []) {
    const rel = String(asset.rel || "").replace(/^\/+/, "");
    if (!rel || rel.includes("..")) continue;
    const buf = Buffer.from(asset.data, "base64");
    if (buf.length < 1) continue;
    await putAsset({ kind: "project", relPath: rel, body: buf });
    assetsWritten++;
  }

  let mergedParts = 0;
  for (const [episodeId, incomingParts] of byEpisode) {
    const admin = await localGetProjectById(episodeId);
    if (!admin) continue;
    const existingParts = getProjectParts(admin);
    const merged = mergePartsForCollaborativeSave({
      existingParts,
      incomingParts,
      userId: submission.submitterUserId,
      userEmail: submission.submitterEmail,
      asAdmin: false,
      isOwner: false,
      allowSceneShrink: true,
    });
    await applySubmitterParts(episodeId, merged);
    mergedParts += incomingParts.length;
  }

  writeInboxMeta({ ...meta, status: "merged" });
  return { mergedParts, assetsWritten };
}

export function rejectInboxSubmission(id: string) {
  const { meta } = readInboxPackage(id);
  writeInboxMeta({ ...meta, status: "rejected" });
}

export function defaultStudioOrigin(): string {
  return (
    process.env.DIV_STUDIO_SYNC_ORIGIN?.trim() ||
    process.env.DIV_STUDIO_ASSET_ORIGIN?.trim() ||
    "http://D-MacBook-Pro.local:8080"
  ).replace(/\/+$/, "");
}
