import { createServerFn } from "@tanstack/react-start";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/integrations/auth/auth-middleware";

const Input = z.object({
  url: z.string().min(1),
  projectId: z.string().uuid(),
  ext: z.string().min(1).max(10),
});

function assetsRoot(): string {
  return path.join(process.cwd(), ".data", "project-assets");
}

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

export const persistProjectAsset = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    if (!data.url) return data.url;
    if (/^https?:\/\//.test(data.url)) return data.url;
    if (data.url.startsWith("/api/assets/")) return data.url;

    const { buffer } = decodeAssetUrl(data.url);
    const dir = path.join(assetsRoot(), userId, data.projectId);
    mkdirSync(dir, { recursive: true });
    const filename = `${randomUUID()}.${data.ext.replace(/^\./, "")}`;
    writeFileSync(path.join(dir, filename), buffer);
    return `/api/assets/${userId}/${data.projectId}/${filename}`;
  });
