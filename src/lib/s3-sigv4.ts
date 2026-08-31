/**
 * Minimal AWS SigV4 presigner built on WebCrypto + fetch.
 *
 * The AWS SDK's S3 client does not reliably work inside the published edge
 * worker (its Node-oriented internals fail there, which surfaced as every
 * `/api/assets/...` request 404-ing on the live site). This module signs
 * requests directly so asset reads work in any runtime.
 */

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
}

function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export interface PresignOptions {
  method: "GET" | "PUT" | "HEAD";
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresIn?: number;
}

/** Presigned URL for a single S3/Spaces object (virtual-hosted style). */
export async function presignS3Url(opts: PresignOptions): Promise<string> {
  const endpoint = /^https?:\/\//i.test(opts.endpoint)
    ? opts.endpoint
    : `https://${opts.endpoint}`;
  const endpointHost = new URL(endpoint).host;
  const host = endpointHost.startsWith(`${opts.bucket}.`)
    ? endpointHost
    : `${opts.bucket}.${endpointHost}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${opts.region}/s3/aws4_request`;

  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${opts.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(opts.expiresIn ?? 3600),
    "X-Amz-SignedHeaders": "host",
  });
  // S3 requires sorted, RFC3986-encoded query parameters.
  const canonicalQuery = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalPath = `/${encodeKeyPath(opts.key.replace(/^\/+/, ""))}`;
  const canonicalRequest = [
    opts.method,
    canonicalPath,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let signingKey: ArrayBuffer | Uint8Array = enc.encode(`AWS4${opts.secretAccessKey}`);
  for (const part of [dateStamp, opts.region, "s3", "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = hex(await hmac(signingKey, stringToSign));

  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
