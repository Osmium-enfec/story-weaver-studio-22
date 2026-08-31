import { createFileRoute } from "@tanstack/react-router";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { isAdminUser } from "@/lib/admin";
import { localGetProjectById } from "@/lib/local-projects-db";
import { putAsset, signedUploadUrl } from "@/lib/object-storage";
import { useCloudStorage, useSpaces } from "@/lib/runtime-backends";

const JsonBody = z.object({
  url: z.string().min(1),
  projectId: z.string().uuid(),
  ext: z.string().min(1).max(10),
});

const DirectUploadBody = z.object({
  action: z.literal("create-direct-upload"),
  projectId: z.string().uuid(),
  ext: z.string().min(1).max(10),
  contentType: z.string().max(100).optional(),
});

function decodeAssetUrl(url: string): { buffer: Buffer; contentType: string } {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid data URL");
    return {
      contentType: match[1],
      buffer: Buffer.from(match[2], "base64"),
    };
  }
  throw new Error("Unsupported asset URL — expected data: URL");
}

async function resolveAssetOwnerUserId(
  requesterId: string,
  projectId: string,
  _asAdmin: boolean,
): Promise<string> {
  // Shared catalog: any signed-in collaborator may upload into a project.
  // Assets are always stored under the project owner's namespace so every
  // viewer resolves the same paths, regardless of who uploaded them.
  try {
    const project = await localGetProjectById(projectId);
    return project?.user_id ?? requesterId;
  } catch {
    return requesterId;
  }
}


async function writeAsset(
  userId: string,
  projectId: string,
  ext: string,
  buffer: Buffer,
  contentType?: string,
): Promise<string> {
  const filename = `${randomUUID()}.${ext.replace(/^\./, "")}`;
  const relPath = path.posix.join(userId, projectId, filename);
  return putAsset({
    kind: "project",
    relPath,
    body: buffer,
    contentType,
  });
}

type DirectUpload =
  | { direct: true; mode: "supabase"; path: string; token: string; url: string }
  | { direct: true; mode: "s3-put"; uploadUrl: string; url: string };

async function createDirectUpload(
  userId: string,
  projectId: string,
  ext: string,
  contentType?: string,
): Promise<DirectUpload> {
  const filename = `${randomUUID()}.${ext.replace(/^\./, "")}`;
  const relPath = path.posix.join(userId, projectId, filename);

  // Spaces / S3: presigned PUT straight from the browser.
  if (useSpaces()) {
    const signed = await signedUploadUrl("project", relPath, contentType);
    if (!signed) throw new Error("Could not prepare upload");
    return { direct: true, mode: "s3-put", uploadUrl: signed.uploadUrl, url: signed.appUrl };
  }

  const storagePath = `project-assets/${relPath}`;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.storage
    .from("project-assets")
    .createSignedUploadUrl(storagePath);
  if (error || !data?.token) {
    throw new Error(error?.message ?? "Could not prepare upload");
  }
  return {
    direct: true,
    mode: "supabase",
    path: storagePath,
    token: data.token,
    url: `/api/assets/${relPath}`,
  };
}

export const Route = createFileRoute("/api/persist-asset")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let user;
        try {
          user = await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        const asAdmin = isAdminUser(user);
        const contentType = request.headers.get("content-type") ?? "";

        // Hosted uploads go straight from the browser to object storage. This
        // avoids request.formData()/arrayBuffer(), both of which duplicate a
        // large recording in the worker and can exceed its memory ceiling.
        if (contentType.includes("application/json")) {
          let raw: unknown;
          try {
            raw = await request.json();
          } catch {
            return jsonError("Invalid JSON", 400);
          }
          const direct = DirectUploadBody.safeParse(raw);
          if (direct.success) {
            if (!useCloudStorage() && !useSpaces()) {
              return jsonResponse({ direct: false });
            }
            try {
              const ownerId = await resolveAssetOwnerUserId(
                user.id,
                direct.data.projectId,
                asAdmin,
              );
              const upload = await createDirectUpload(
                ownerId,
                direct.data.projectId,
                direct.data.ext,
                direct.data.contentType,
              );
              return jsonResponse({ ...upload });
            } catch (e) {
              return jsonError(e instanceof Error ? e.message : "Could not prepare upload", 500);
            }
          }

          const parsed = JsonBody.safeParse(raw);
          if (!parsed.success) {
            return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
          }

          const data = parsed.data;
          if (!data.url) return jsonResponse({ url: data.url });
          if (/^https?:\/\//.test(data.url)) return jsonResponse({ url: data.url });
          if (data.url.startsWith("/api/assets/")) return jsonResponse({ url: data.url });

          try {
            const { buffer, contentType: ct } = decodeAssetUrl(data.url);
            const ownerId = await resolveAssetOwnerUserId(user.id, data.projectId, asAdmin);
            const url = await writeAsset(ownerId, data.projectId, data.ext, buffer, ct);
            return jsonResponse({ url });
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Persist failed", 500);
          }
        }

        // Multipart: preferred for large screen recordings (avoids huge data URLs).
        if (contentType.includes("multipart/form-data")) {
          try {
            const form = await request.formData();
            const projectId = String(form.get("projectId") ?? "");
            const extRaw = String(form.get("ext") ?? "mp4");
            const file = form.get("file");
            if (!z.string().uuid().safeParse(projectId).success) {
              return jsonError("Invalid projectId", 400);
            }
            if (!(file instanceof File)) {
              return jsonError("file required", 400);
            }
            const ext = extRaw.replace(/^\./, "").slice(0, 10) || "mp4";
            const buffer = Buffer.from(await file.arrayBuffer());
            if (buffer.length === 0) return jsonError("Empty file", 400);
            const ownerId = await resolveAssetOwnerUserId(user.id, projectId, asAdmin);
            const url = await writeAsset(
              ownerId,
              projectId,
              ext,
              buffer,
              file.type || undefined,
            );
            return jsonResponse({ url });
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Persist failed", 500);
          }
        }

        return jsonError("Unsupported content type", 415);
      },
    },
  },
});
