import { createFileRoute } from "@tanstack/react-router";
import { mkdirSync, existsSync, unlinkSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { jsonError, jsonResponse, requireApiUser } from "@/lib/api-auth";
import { hostProjectAssetsRoot } from "@/lib/host-storage";
import { persistProjectLocalFile, resolveUserAssetLocalPath } from "@/lib/project-asset-path";
import { scratchRoot, useCloudStorage, useSpaces } from "@/lib/runtime-backends";
import {
  probeMediaDurationMs,
  resolveFfmpegBin,
  runFfmpeg,
} from "@/lib/ffmpeg-bin";

const Body = z.object({
  projectId: z.string().uuid(),
  videoUrl: z.string().min(1),
});

export const Route = createFileRoute("/api/extract-video-audio")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let user;
        try {
          user = await requireApiUser(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }

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

        let videoPath: string | null = null;
        try {
          videoPath = await resolveUserAssetLocalPath(
            parsed.data.videoUrl,
            user.id,
            `extract-${user.id}`,
          );
        } catch (e) {
          console.error("[extract-video-audio] resolve failed", e);
          return jsonError(
            e instanceof Error ? e.message : "Video asset not found",
            404,
          );
        }
        if (!videoPath) return jsonError("Video asset not found", 404);


        let ffmpegBin: string;
        try {
          ffmpegBin = await resolveFfmpegBin();
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : "ffmpeg missing", 503);
        }

        const workDir = useSpaces() || useCloudStorage()
          ? path.join(scratchRoot(), "extract", user.id, parsed.data.projectId)
          : path.join(hostProjectAssetsRoot(), user.id, parsed.data.projectId);
        mkdirSync(workDir, { recursive: true });
        const filename = `${randomUUID()}.mp3`;
        const outPath = path.join(workDir, filename);
        const tmpPath = `${outPath}.tmp.mp3`;

        try {
          await runFfmpeg(ffmpegBin, [
            "-y",
            "-fflags",
            "+genpts",
            "-i",
            videoPath,
            "-vn",
            "-af",
            "asetpts=PTS-STARTPTS",
            "-acodec",
            "libmp3lame",
            "-q:a",
            "4",
            tmpPath,
          ]);
          if (!existsSync(tmpPath) || statSync(tmpPath).size < 32) {
            try {
              unlinkSync(tmpPath);
            } catch {
              /* ignore */
            }
            return jsonError(
              "This video has no usable audio track. Use Screen recording + TTS instead.",
              400,
            );
          }
          renameSync(tmpPath, outPath);
          const durationMs =
            (await probeMediaDurationMs(ffmpegBin, outPath)) ||
            (await probeMediaDurationMs(ffmpegBin, videoPath));
          if (!durationMs) {
            return jsonError("Could not read audio duration", 500);
          }
          const url = await persistProjectLocalFile({
            userId: user.id,
            projectId: parsed.data.projectId,
            filename,
            localPath: outPath,
            contentType: "audio/mpeg",
          });
          return jsonResponse({
            url,
            durationMs,
          });
        } catch (e) {
          try {
            unlinkSync(tmpPath);
          } catch {
            /* ignore */
          }
          try {
            unlinkSync(outPath);
          } catch {
            /* ignore */
          }
          return jsonError(
            e instanceof Error ? e.message : "Could not extract audio from video",
            500,
          );
        }
      },
    },
  },
});
