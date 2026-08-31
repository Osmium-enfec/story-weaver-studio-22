import { createFileRoute } from "@tanstack/react-router";
import { jsonError, jsonResponse, requireApiAdmin } from "@/lib/api-auth";
import { useSpaces } from "@/lib/runtime-backends";

/**
 * One-time admin maintenance: set the CORS rule on the Spaces bucket so the
 * browser can PUT directly to presigned upload URLs from Lovable origins.
 */
export const Route = createFileRoute("/api/spaces-cors")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          await requireApiAdmin(request);
        } catch (e) {
          return e instanceof Response ? e : jsonError("Unauthorized", 401);
        }
        if (!useSpaces()) return jsonError("Spaces not configured", 400);
        try {
          const { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } =
            await import("@aws-sdk/client-s3");
          const endpoint = process.env.SPACES_ENDPOINT!.trim();
          const bucket = process.env.SPACES_BUCKET!.trim();
          const client = new S3Client({
            endpoint: /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`,
            region: process.env.SPACES_REGION?.trim() || "blr1",
            credentials: {
              accessKeyId: process.env.SPACES_KEY!.trim(),
              secretAccessKey: process.env.SPACES_SECRET!.trim(),
            },
            forcePathStyle: false,
          });
          await client.send(
            new PutBucketCorsCommand({
              Bucket: bucket,
              CORSConfiguration: {
                CORSRules: [
                  {
                    AllowedOrigins: [
                      "https://*.lovableproject.com",
                      "https://*.lovable.app",
                      "http://localhost:*",
                    ],
                    AllowedMethods: ["GET", "PUT", "HEAD"],
                    AllowedHeaders: ["*"],
                    ExposeHeaders: ["ETag"],
                    MaxAgeSeconds: 3600,
                  },
                ],
              },
            }),
          );
          const res = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
          return jsonResponse({ ok: true, rules: res.CORSRules });
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : "CORS update failed", 500);
        }
      },
    },
  },
});
