/**
 * Work sync API — assignments push/pull + collaborator work submit/merge.
 *
 * LAN admin host publishes assignments-latest.json under .data/sync/.
 * Desktop apps pull that file and can POST work packages back, or download a
 * return zip when offline.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { isAdminUser } from "@/lib/admin";
import {
  applyAssignmentsSnapshot,
  buildAssignmentsSnapshot,
  buildWorkSubmission,
  defaultStudioOrigin,
  listInbox,
  mergeInboxSubmission,
  readAssignmentsSnapshot,
  rejectInboxSubmission,
  saveSubmissionToInbox,
  syncSnapshotAssets,
  writeAssignmentsSnapshot,
  type AssignmentsSnapshot,
  type WorkSubmission,
} from "@/lib/work-sync";
import { fetchStudio } from "@/lib/studio-lan";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pushAssignments") }),
  z.object({ action: z.literal("getAssignmentsStatus") }),
  z.object({
    action: z.literal("pullFromAdmin"),
    /** Override LAN origin; defaults to DIV_STUDIO_ASSET_ORIGIN. */
    origin: z.string().url().optional(),
  }),
  z.object({
    action: z.literal("sendMyWork"),
    /** When true, only build the package (for zip download). */
    zipOnly: z.boolean().optional(),
    origin: z.string().url().optional(),
  }),
  z.object({
    action: z.literal("submitWork"),
    package: z.any(),
  }),
  z.object({ action: z.literal("listInbox") }),
  z.object({
    action: z.literal("mergeSubmission"),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.literal("rejectSubmission"),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.literal("importWorkPackage"),
    package: z.any(),
  }),
]);

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError("Invalid JSON", 400);
        }

        const parsed = Body.safeParse(body);
        if (!parsed.success) {
          return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
        }
        const data = parsed.data;

        // submitWork is intentionally open on LAN (no shared session across Macs).
        // Ownership is re-checked against admin assignments on merge.
        if (data.action === "submitWork") {
          const pkg = data.package as WorkSubmission;
          if (!pkg || pkg.kind !== "work" || !Array.isArray(pkg.parts)) {
            return jsonError("Invalid work package", 400);
          }
          if (!pkg.submitterEmail || !pkg.parts.length) {
            return jsonError("Work package has no parts to submit", 400);
          }
          const entry = saveSubmissionToInbox(pkg);
          try {
            const merged = await mergeInboxSubmission(entry.id);
            return jsonResponse({
              ok: true,
              id: entry.id,
              ...merged,
              message:
                `Saved ${merged.mergedParts} part(s) from ${entry.submitterEmail} ` +
                `into the main database with ${merged.assetsWritten} asset(s).`,
            });
          } catch (error: unknown) {
            return jsonError(
              error instanceof Error
                ? error.message
                : "Work was received but could not be merged",
              409,
            );
          }
        }

        let user;
        try {
          user = await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }
        const asAdmin = isAdminUser(user);

        if (data.action === "pushAssignments") {
          if (!asAdmin) return jsonError("Admin only.", 403);
          try {
            const snapshot = await buildAssignmentsSnapshot(user.email);
            writeAssignmentsSnapshot(snapshot);
            return jsonResponse({
              ok: true,
              pushedAt: snapshot.pushedAt,
              episodeCount: snapshot.episodes.length,
              message: `Pushed assignments for ${snapshot.episodes.length} episode(s). Each collaborator must Get latest data while signed in as themselves — not as admin.`,
            });
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Push failed", 500);
          }
        }

        if (data.action === "getAssignmentsStatus") {
          const snap = readAssignmentsSnapshot();
          return jsonResponse({
            ok: true,
            hasSnapshot: !!snap,
            pushedAt: snap?.pushedAt ?? null,
            pushedByEmail: snap?.pushedByEmail ?? null,
            episodeCount: snap?.episodes.length ?? 0,
            origin: defaultStudioOrigin(),
          });
        }

        if (data.action === "pullFromAdmin") {
          try {
            const query = new URLSearchParams({
              userId: user.id,
              email: user.email,
            });
            let { res, origin } = await fetchStudio(
              `/api/sync-feed/python-for-ai-latest.json?${query}`,
              { origin: data.origin },
            );
            if (res.status === 404) {
              ({ res, origin } = await fetchStudio(
                "/api/sync-feed/assignments-latest.json",
                { origin },
              ));
            }
            if (!res.ok) {
              const payload = (await res.json().catch(() => null)) as {
                error?: string;
              } | null;
              return jsonError(
                payload?.error ||
                  `Could not reach the main Studio database (${res.status}). Is the admin Mac running on the LAN?`,
                502,
              );
            }
            const snapshot = (await res.json()) as AssignmentsSnapshot;
            if (snapshot?.kind !== "assignments") {
              return jsonError("Admin returned an invalid assignments snapshot.", 502);
            }
            if (
              snapshot.scopedTo?.email &&
              snapshot.scopedTo.email.trim().toLowerCase() !==
                user.email.trim().toLowerCase()
            ) {
              return jsonError("Admin returned data for a different collaborator.", 502);
            }
            if (snapshot.missingAssets?.length) {
              return jsonError(
                `The main database references ${snapshot.missingAssets.length} missing asset(s). Ask the admin to restore them before syncing.`,
                502,
              );
            }
            const assetResult = await syncSnapshotAssets(snapshot, origin);
            if (assetResult.assetsFailed.length) {
              return jsonError(
                `Could not download ${assetResult.assetsFailed.length} asset(s) from the main Mac. No database changes were applied.`,
                502,
              );
            }
            const result = await applyAssignmentsSnapshot(snapshot, {
              userId: user.id,
              userEmail: user.email,
            });
            return jsonResponse({
              ok: true,
              origin,
              pushedAt: snapshot.pushedAt,
              ...assetResult,
              ...result,
              message:
                `Latest Python for AI data loaded: ${result.episodesTouched} episode(s), ` +
                `${result.partsAssignedToMe} assigned part(s), ${assetResult.assetsDownloaded} new/updated asset(s). ` +
                `${result.partsPreserved} existing assigned part(s) kept to protect unsent work.`,
            });
          } catch (e) {
            return jsonError(
              e instanceof Error ? e.message : "Pull failed",
              502,
            );
          }
        }

        if (data.action === "sendMyWork") {
          try {
            const pkg = await buildWorkSubmission({
              userId: user.id,
              email: user.email,
            });
            if (!pkg.parts.length) {
              return jsonError(
                "No assigned parts to send. Ask admin to assign parts to you and push updates.",
                400,
              );
            }

            if (data.zipOnly) {
              return jsonResponse({
                ok: true,
                mode: "zip",
                package: pkg,
                filename: `Div-Studio-work-${user.email.split("@")[0]}-${Date.now()}.json`,
                message: "Download this file and send it to admin (AirDrop / USB).",
              });
            }

            try {
              const { res, origin } = await fetchStudio("/api/sync", {
                origin: data.origin,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "submitWork", package: pkg }),
              });
              const payload = (await res.json()) as {
                ok?: boolean;
                error?: string;
                message?: string;
                id?: string;
              };
              if (!res.ok || !payload.ok) {
                throw new Error(payload.error || `LAN submit failed (${res.status})`);
              }
              return jsonResponse({
                ok: true,
                mode: "lan",
                origin,
                submissionId: payload.id,
                partCount: pkg.parts.length,
                assetCount: pkg.assets.length,
                message: payload.message || "Work sent to admin over LAN.",
              });
            } catch (lanErr) {
              // Option C fallback: return package for local download.
              return jsonResponse({
                ok: true,
                mode: "zip",
                package: pkg,
                filename: `Div-Studio-work-${user.email.split("@")[0]}-${Date.now()}.json`,
                lanError:
                  lanErr instanceof Error ? lanErr.message : String(lanErr),
                message:
                  "LAN submit failed — download the return file and send it to admin instead.",
              });
            }
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Send failed", 500);
          }
        }

        if (data.action === "listInbox") {
          if (!asAdmin) return jsonError("Admin only.", 403);
          return jsonResponse({ ok: true, items: listInbox() });
        }

        if (data.action === "mergeSubmission") {
          if (!asAdmin) return jsonError("Admin only.", 403);
          try {
            const result = await mergeInboxSubmission(data.id);
            return jsonResponse({
              ok: true,
              ...result,
              message: `Merged ${result.mergedParts} part(s), wrote ${result.assetsWritten} asset(s).`,
            });
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Merge failed", 400);
          }
        }

        if (data.action === "rejectSubmission") {
          if (!asAdmin) return jsonError("Admin only.", 403);
          try {
            rejectInboxSubmission(data.id);
            return jsonResponse({ ok: true, message: "Submission rejected." });
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Reject failed", 400);
          }
        }

        if (data.action === "importWorkPackage") {
          if (!asAdmin) return jsonError("Admin only.", 403);
          const pkg = data.package as WorkSubmission;
          if (!pkg || pkg.kind !== "work" || !Array.isArray(pkg.parts)) {
            return jsonError("Invalid work package", 400);
          }
          const entry = saveSubmissionToInbox(pkg);
          try {
            const merged = await mergeInboxSubmission(entry.id);
            return jsonResponse({
              ok: true,
              id: entry.id,
              ...merged,
              message:
                `Imported and saved ${merged.mergedParts} part(s) from ` +
                `${entry.submitterEmail} into the main database.`,
            });
          } catch (error: unknown) {
            return jsonError(
              error instanceof Error ? error.message : "Imported work could not be merged",
              409,
            );
          }
        }

        return jsonError("Unknown action", 400);
      },
    },
  },
});
