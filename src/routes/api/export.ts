import { createFileRoute } from "@tanstack/react-router";
import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { isAdminUser } from "@/lib/admin";
import {
  createExportJob,
  cancelExportJob,
  deleteExportJob,
  resumeExportJob,
  getExportJob,
  getExportJobForUser,
  listExportJobsForUser,
  readJobPayload,
  readJobBgFrame,
  readJobRecordingFrame,
  assertFfmpegAvailable,
} from "@/lib/native-export-jobs";
import type { ExportQuality } from "@/lib/export-rasterize";

const StartBody = z.object({
  scenes: z.array(z.any()).min(1),
  masterAudioUrl: z.string().optional(),
  quality: z.enum(["preview", "hd"]),
  background: z.any().optional(),
  bgm: z.any().nullable().optional(),
  filename: z.string().min(1).max(200).optional(),
});

function baseUrlFromRequest(request: Request): string {
  // Prefer the public origin so Playwright can load nginx-hosted bumpers
  // (/common-intro.mp4, /common-outro.mp4). Use EXPORT_INTERNAL_BASE_URL only
  // when EXPORT_BASE_URL is unset (e.g. local LAN).
  const env = process.env.EXPORT_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  const internal = process.env.EXPORT_INTERNAL_BASE_URL?.trim();
  if (internal) return internal.replace(/\/$/, "");
  const url = new URL(request.url);
  // Prefer Host header (works behind vite / LAN).
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (url.protocol === "https:" ? "https" : "http");
  if (host) return `${proto}://${host}`;
  return `${url.protocol}//${url.host}`;
}

export const Route = createFileRoute("/api/export")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let user;
        try {
          user = await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        const url = new URL(request.url);
        if (url.searchParams.get("resume") === "1") {
          const jobId = url.searchParams.get("jobId");
          if (!jobId) return jsonError("jobId required", 400);
          try {
            await assertFfmpegAvailable();
            const job = resumeExportJob(jobId, user.id, isAdminUser(user));
            return jsonResponse({
              jobId: job.id,
              status: job.status,
              stage: job.stage,
            });
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            const status =
              msg.includes("Not allowed")
                ? 403
                : msg.includes("already running")
                  ? 409
                  : msg.includes("not found")
                    ? 404
                    : 400;
            return jsonError(msg, status);
          }
        }

        try {
          await assertFfmpegAvailable();
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : "ffmpeg missing", 503);
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError("Invalid JSON", 400);
        }
        const parsed = StartBody.safeParse(body);
        if (!parsed.success) {
          return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
        }

        const data = parsed.data;
        const quality = data.quality as ExportQuality;
        const filename =
          data.filename?.replace(/[^\w.\- ]+/g, "").trim() ||
          `explainer-${quality === "hd" ? "1080p" : "720p"}-${Date.now()}.mp4`;

        const job = createExportJob({
          userId: user.id,
          baseUrl: baseUrlFromRequest(request),
          payload: {
            scenes: data.scenes,
            masterAudioUrl: data.masterAudioUrl,
            quality,
            background: data.background,
            bgm: data.bgm ?? null,
            filename: filename.endsWith(".mp4") ? filename : `${filename}.mp4`,
          },
        });

        return jsonResponse({
          jobId: job.id,
          status: job.status,
        });
      },

      GET: async ({ request }) => {
        const url = new URL(request.url);
        const jobId = url.searchParams.get("jobId");
        const download = url.searchParams.get("download") === "1";
        const runner = url.searchParams.get("runner") === "1";
        const token = url.searchParams.get("token");

        // Headless runner fetches payload / bg frames with job token (no user session).
        if (runner) {
          if (!jobId || !token) return jsonError("jobId and token required", 400);
          const bgFrame = url.searchParams.get("bgFrame");
          if (bgFrame != null) {
            try {
              const idx = Number(bgFrame);
              const { bytes, contentType } = readJobBgFrame(jobId, token, idx);
              return new Response(bytes, {
                status: 200,
                headers: {
                  "Content-Type": contentType,
                  "Cache-Control": "no-store",
                },
              });
            } catch (e) {
              return jsonError(e instanceof Error ? e.message : "Not found", 404);
            }
          }
          const recFrame = url.searchParams.get("recFrame");
          const recVideo = url.searchParams.get("recVideo");
          if (recFrame != null && recVideo != null) {
            try {
              const { bytes, contentType } = readJobRecordingFrame(
                jobId,
                token,
                Number(recVideo),
                Number(recFrame),
              );
              return new Response(bytes, {
                status: 200,
                headers: {
                  "Content-Type": contentType,
                  "Cache-Control": "no-store",
                },
              });
            } catch (e) {
              return jsonError(e instanceof Error ? e.message : "Not found", 404);
            }
          }
          try {
            const payload = readJobPayload(jobId, token);
            return jsonResponse(payload);
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : "Not found", 404);
          }
        }

        let user;
        try {
          user = await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        if (url.searchParams.get("list") === "1") {
          const { isAdminUser } = await import("@/lib/admin");
          const { listAllExportJobs } = await import("@/lib/native-export-jobs");
          const { localGetUserById } = await import("@/lib/local-auth-db");
          if (isAdminUser(user) && url.searchParams.get("all") === "1") {
            const jobs = await Promise.all(
              listAllExportJobs().map(async (j) => ({
                ...j,
                userEmail: j.userId
                  ? (await localGetUserById(j.userId))?.email ?? "(unknown)"
                  : "(legacy)",
              })),
            );
            return jsonResponse({ jobs, allUsers: true });
          }
          return jsonResponse({ jobs: listExportJobsForUser(user.id) });
        }

        if (!jobId) return jsonError("jobId required", 400);
        const job =
          getExportJobForUser(jobId, user.id) ??
          (isAdminUser(user) ? getExportJob(jobId) : undefined);
        if (!job) return jsonError("Export job not found", 404);

        if (download) {
          if (job.status !== "done" || !job.outputPath || !existsSync(job.outputPath)) {
            return jsonError("Export not ready", 409);
          }
          const stat = statSync(job.outputPath);
          const bytes = readFileSync(job.outputPath);
          return new Response(bytes, {
            status: 200,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(stat.size),
              "Content-Disposition": `attachment; filename="${job.payload.filename}"`,
            },
          });
        }

        return jsonResponse({
          jobId: job.id,
          status: job.status,
          stage: job.stage,
          progress: job.progress,
          error: job.error,
          filename: job.payload.filename,
        });
      },

      DELETE: async ({ request }) => {
        let user;
        try {
          user = await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

        const url = new URL(request.url);
        const jobId = url.searchParams.get("jobId");
        if (!jobId) return jsonError("jobId required", 400);
        const stop = url.searchParams.get("stop") === "1";

        try {
          if (stop) {
            await cancelExportJob(jobId, user.id, isAdminUser(user));
            return jsonResponse({ ok: true, stopped: true });
          }
          await deleteExportJob(jobId, user.id, isAdminUser(user));
          return jsonResponse({ ok: true });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          const status =
            msg.includes("Not allowed")
              ? 403
              : msg.includes("still running")
                ? 409
                : 404;
          return jsonError(msg, status);
        }
      },
    },
  },
});
