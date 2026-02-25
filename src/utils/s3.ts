export interface BucketConfig {
  id: string;
  bucketName: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

interface PresignInput {
  method: "PUT" | "GET" | "HEAD" | "DELETE";
  bucket: BucketConfig;
  objectKey: string;
  expiresInSeconds: number;
  now?: Date;
  headers?: Record<string, string>;
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key: ArrayBuffer | Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const keyData = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalizeHeaders(headers: Record<string, string>): { canonical: string; signedHeaders: string } {
  const normalized = Object.entries(headers)
    .map(([k, v]) => [k.trim().toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    canonical: normalized.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders: normalized.map(([k]) => k).join(";")
  };
}

async function getSigningKey(secretKey: string, dateStamp: string, region: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, "s3");
  return hmacSha256(kService, "aws4_request");
}

export async function presignUrl(input: PresignInput): Promise<string> {
  const now = input.now ?? new Date();
  const endpoint = new URL(input.bucket.endpoint);
  const host = endpoint.host;
  const protocol = endpoint.protocol || "https:";
  const canonicalUri = `/${encodeRfc3986(input.bucket.bucketName)}/${input.objectKey
    .split("/")
    .map((part) => encodeRfc3986(part))
    .join("/")}`;

  const amzDate = formatAmzDate(now);
  const dateStamp = formatDate(now);
  const credentialScope = `${dateStamp}/${input.bucket.region}/s3/aws4_request`;

  const headers = {
    host,
    ...(input.headers ?? {})
  };

  const { canonical, signedHeaders } = canonicalizeHeaders(headers);

  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.bucket.accessKey}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresInSeconds),
    "X-Amz-SignedHeaders": signedHeaders
  });

  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join("&");

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonical,
    signedHeaders,
    "UNSIGNED-PAYLOAD"
  ].join("\n");

  const hashedCanonicalRequest = toHex(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest)));
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, hashedCanonicalRequest].join("\n");

  const signingKey = await getSigningKey(input.bucket.secretKey, dateStamp, input.bucket.region);
  const signature = toHex(await hmacSha256(signingKey, stringToSign));
  query.set("X-Amz-Signature", signature);

  return `${protocol}//${host}${canonicalUri}?${query.toString()}`;
}
