import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { rasterizeExportFrames } from "@/lib/export-rasterize";
import type { ExportJobPayload } from "@/lib/export-job-types";

declare global {
  interface Window {
    __exportOnProgress?: (stage: string, ratio: number) => Promise<void> | void;
    __exportWriteFrame?: (
      b64: string,
      frameIndex: number,
      totalFrames: number,
    ) => Promise<void>;
    __exportWriteAudio?: (b64: string) => Promise<void>;
    __exportFinish?: (totalMs: number, totalFrames: number) => Promise<void>;
    __exportFail?: (message: string) => Promise<void>;
  }
}

/** One rasterize run per job — prevents Strict Mode / remount double-writes. */
const exportRunLocks = new Map<string, AbortController>();

export const Route = createFileRoute("/export-runner")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>): { jobId?: string; token?: string } => ({
    jobId: typeof s.jobId === "string" ? s.jobId : undefined,
    token: typeof s.token === "string" ? s.token : undefined,
  }),
  head: () => ({ meta: [{ title: "Export runner" }] }),
  component: ExportRunnerPage,
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return bytesToBase64(buf);
}

function ExportRunnerPage() {
  const { jobId, token } = Route.useSearch();
  const [status, setStatus] = useState("Starting…");

  useEffect(() => {
    if (!jobId || !token) {
      setStatus("Missing jobId/token");
      void window.__exportFail?.("Missing jobId/token");
      return;
    }

    const lockKey = `${jobId}:${token}`;
    exportRunLocks.get(lockKey)?.abort();
    const ac = new AbortController();
    exportRunLocks.set(lockKey, ac);

    (async () => {
      try {
        setStatus("Loading job…");
        const res = await fetch(
          `/api/export?runner=1&jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(token)}`,
          { signal: ac.signal },
        );
        if (ac.signal.aborted) return;

        const data = (await res.json()) as ExportJobPayload & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Failed to load export job");

        if (!window.__exportWriteFrame || !window.__exportFinish) {
          throw new Error("Export bridge not available (open via Playwright job runner)");
        }

        setStatus("Rasterizing…");
        const bgFrames = data.backgroundFrames;
        const backgroundFrames =
          bgFrames && bgFrames.count > 0
            ? {
                ...bgFrames,
                urls: Array.from({ length: bgFrames.count }, (_, i) =>
                  `/api/export?runner=1&jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(token)}&bgFrame=${i + 1}`,
                ),
              }
            : undefined;

        const recordingVideos = (data.recordingVideos ?? []).map((rv, videoIndex) => ({
          mediaUrl: rv.mediaUrl,
          fps: rv.fps,
          durationMs: rv.durationMs,
          urls: Array.from({ length: rv.count }, (_, i) =>
            `/api/export?runner=1&jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(token)}&recVideo=${videoIndex}&recFrame=${i + 1}`,
          ),
        }));

        const result = await rasterizeExportFrames({
          scenes: data.scenes,
          masterAudioUrl: data.masterAudioUrl,
          quality: data.quality,
          background: data.background,
          bgm: data.bgm,
          backgroundFrames,
          recordingVideos: recordingVideos.length > 0 ? recordingVideos : undefined,
          audioOnly: data.audioOnly === true,
          signal: ac.signal,
          onProgress: (stage, ratio) => {
            if (ac.signal.aborted) return;
            setStatus(stage);
            void window.__exportOnProgress?.(stage, ratio);
          },
          onFrame: async (png, frameIndex, totalFrames) => {
            if (ac.signal.aborted) return;
            if (data.audioOnly) return;
            await window.__exportWriteFrame!(bytesToBase64(png), frameIndex, totalFrames);
          },
        });

        if (ac.signal.aborted) return;

        if (result.audioBlob) {
          setStatus("Sending audio…");
          await window.__exportWriteAudio?.(await blobToBase64(result.audioBlob));
        }

        if (ac.signal.aborted) return;

        setStatus("Finishing…");
        await window.__exportFinish!(result.totalMs, result.totalFrames);
        setStatus("Done");
      } catch (e: unknown) {
        if (ac.signal.aborted) return;
        const msg =
          e instanceof Error
            ? e.message
            : e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : e && typeof e === "object" && "type" in e
                ? `Media load failed (${String((e as { type: unknown }).type)})`
                : String(e);
        setStatus(msg);
        await window.__exportFail?.(msg);
      } finally {
        if (exportRunLocks.get(lockKey) === ac) {
          exportRunLocks.delete(lockKey);
        }
      }
    })();

    return () => {
      ac.abort();
    };
  }, [jobId, token]);

  return (
    <div style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1 style={{ fontSize: 16, margin: 0 }}>Native export runner</h1>
      <p style={{ color: "#666", marginTop: 8 }}>{status}</p>
    </div>
  );
}
