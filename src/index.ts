import { parseClientCode, userPrefix } from "./utils/clientCode";
import { hitRateLimit } from "./utils/rateLimit";
import { presignUrl, type BucketConfig } from "./utils/s3";
import { signSessionToken, verifySessionToken } from "./utils/token";

interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
  BUCKET_CONFIGS_JSON: string;
  TOKEN_TTL_SECONDS?: string;
  URL_TTL_SECONDS?: string;
  MAX_UPLOAD_BYTES?: string;
  RATE_LIMIT_WINDOW_MS?: string;
  RATE_LIMIT_MAX_REQUESTS?: string;
}

interface UserRow {
  client_code: string;
  bucket_id: string;
  quota_gb: number;
  used_bytes: number;
  uploads_count: number;
  downloads_count: number;
  subscription_expires_at: string;
  last_activity_at: string | null;
}

interface FileRow {
  file_id: string;
  client_code: string;
  object_key: string;
  size_bytes: number | null;
  mime_type: string | null;
  status: string;
  deleted_at: string | null;
  created_at: string;
}

const GB = 1024 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const badRequest = (message: string, status = 400) =>
  json({ error: message }, status);

function parseBucketConfigs(raw: string): Record<string, BucketConfig> {
  const parsed = JSON.parse(raw) as BucketConfig[];
  return parsed.reduce<Record<string, BucketConfig>>((acc, bucket) => {
    acc[bucket.id] = bucket;
    return acc;
  }, {});
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { value: String(error) };
}

async function getUser(
  db: D1Database,
  clientCode: string,
): Promise<UserRow | null> {
  const result = await db
    .prepare("SELECT * FROM users WHERE client_code = ?")
    .bind(clientCode)
    .first<UserRow>();
  return result ?? null;
}

async function getAuthClientCode(
  request: Request,
  env: Env,
): Promise<string | null> {
  const header = request.headers.get("authorization") || "";
  const [, token] = header.split(" ");
  if (!token) return null;
  const payload = await verifySessionToken(token, env.SESSION_SECRET);
  return payload?.clientCode ?? null;
}

function isSubscriptionActive(iso: string): boolean {
  return Date.now() < new Date(iso).getTime();
}

function monthPathParts(date = new Date()): { yyyy: string; mm: string } {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return { yyyy, mm };
}

async function verifyObjectAndReadHeaders(
  url: string,
): Promise<{ sizeBytes: number; contentType: string | null }> {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`Unable to verify upload: ${response.status}`);
  }
  const size = Number(response.headers.get("content-length") || 0);
  return { sizeBytes: size, contentType: response.headers.get("content-type") };
}

function usagePayload(user: UserRow) {
  return {
    quotaGb: user.quota_gb,
    usedBytes: user.used_bytes,
    uploadsCount: user.uploads_count,
    downloadsCount: user.downloads_count,
    expiresAt: user.subscription_expires_at,
  };
}

function validateBucketConfig(bucket: BucketConfig): string | null {
  if (!bucket.endpoint) return "bucket endpoint is missing";
  if (!bucket.bucketName) return "bucket name is missing";
  if (!bucket.region) return "bucket region is missing";
  if (!bucket.accessKey) return "bucket access key is missing";
  if (!bucket.secretKey) return "bucket secret key is missing";

  try {
    new URL(bucket.endpoint);
  } catch {
    return "bucket endpoint is not a valid URL";
  }

  return null;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const requestId = crypto.randomUUID();
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const url = new URL(request.url);

    try {
      const limit = Number(env.RATE_LIMIT_MAX_REQUESTS ?? 60);
      const windowMs = Number(env.RATE_LIMIT_WINDOW_MS ?? 60_000);

      if (hitRateLimit(ip, limit, windowMs)) {
        return badRequest("Too many requests", 429);
      }

      if (!env.SESSION_SECRET) {
        console.error("[vault-api] missing SESSION_SECRET", {
          requestId,
          path: url.pathname,
        });
        return badRequest("Server misconfigured", 500);
      }

      if (!env.BUCKET_CONFIGS_JSON) {
        console.error("[vault-api] missing BUCKET_CONFIGS_JSON", {
          requestId,
          path: url.pathname,
        });
        return badRequest("Server misconfigured", 500);
      }

      if (request.method === "POST" && url.pathname === "/auth/login") {
        const body = (await request.json().catch(() => null)) as {
          clientCode?: string;
        } | null;
        if (!body?.clientCode) return badRequest("clientCode is required");

        const clientCode = parseClientCode(body.clientCode);
        if (!clientCode) return badRequest("Invalid client code format");

        const user = await getUser(env.DB, clientCode);
        if (!user) return badRequest("Unknown client code", 404);

        const now = Math.floor(Date.now() / 1000);
        const expiresInSeconds = Number(env.TOKEN_TTL_SECONDS ?? 86_400);
        const token = await signSessionToken(
          {
            clientCode,
            iat: now,
            exp: now + expiresInSeconds,
          },
          env.SESSION_SECRET,
        );

        return json({
          token,
          expiresInSeconds,
          ...usagePayload(user),
          subscriptionActive: isSubscriptionActive(
            user.subscription_expires_at,
          ),
        });
      }

      let buckets: Record<string, BucketConfig>;
      try {
        buckets = parseBucketConfigs(env.BUCKET_CONFIGS_JSON);
      } catch (error) {
        console.error("[vault-api] invalid BUCKET_CONFIGS_JSON", {
          requestId,
          path: url.pathname,
          error: serializeError(error),
        });
        return badRequest("Server misconfigured: invalid bucket config", 500);
      }

      const clientCode = await getAuthClientCode(request, env);
      if (!clientCode) {
        return badRequest("Unauthorized", 401);
      }

      const user = await getUser(env.DB, clientCode);
      if (!user) {
        return badRequest("Unauthorized", 401);
      }

      const bucket = buckets[user.bucket_id];
      if (!bucket) {
        return badRequest("User bucket is not configured", 500);
      }

      const bucketIssue = validateBucketConfig(bucket);
      if (bucketIssue) {
        console.error("[vault-api] invalid bucket configuration for user", {
          requestId,
          path: url.pathname,
          clientCode,
          bucketId: user.bucket_id,
          bucketEndpoint: bucket.endpoint,
          bucketIssue,
        });
        return badRequest(`Server misconfigured: ${bucketIssue}`, 500);
      }

      if (request.method === "POST" && url.pathname === "/uploads/request") {
        const body = (await request.json().catch(() => null)) as {
          mimeType?: string;
          sizeBytes?: number;
        } | null;
        if (!body?.mimeType || !Number.isFinite(body.sizeBytes)) {
          return badRequest("mimeType and sizeBytes are required");
        }

        const sizeBytes = Number(body.sizeBytes);
        if (sizeBytes <= 0) return badRequest("sizeBytes must be positive");

        const maxUploadBytes = Number(
          env.MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024 * 1024,
        );
        if (sizeBytes > maxUploadBytes)
          return badRequest("File too large for plan", 403);

        if (!isSubscriptionActive(user.subscription_expires_at)) {
          return badRequest("Subscription expired", 403);
        }

        const maxBytes = user.quota_gb * GB;
        if (user.used_bytes + sizeBytes > maxBytes) {
          return badRequest("Quota exceeded", 403);
        }

        const fileId = crypto.randomUUID();
        const { yyyy, mm } = monthPathParts();
        const objectKey = `${userPrefix(clientCode)}/${yyyy}/${mm}/${fileId}`;
        const nowIso = new Date().toISOString();

        await env.DB.prepare(
          `INSERT INTO files (file_id, client_code, object_key, size_bytes, mime_type, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        )
          .bind(fileId, clientCode, objectKey, sizeBytes, body.mimeType, nowIso)
          .run();

        const ttl = Number(env.URL_TTL_SECONDS ?? 300);
        const uploadUrl = await presignUrl({
          method: "PUT",
          bucket,
          objectKey,
          expiresInSeconds: ttl,
          headers: {
            "content-type": body.mimeType,
            "content-length": String(sizeBytes),
          },
        });

        return json({
          fileId,
          objectKey,
          uploadUrl,
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
          requiredHeaders: {
            "content-type": body.mimeType,
            "content-length": String(sizeBytes),
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/uploads/complete") {
        const body = (await request.json().catch(() => null)) as {
          fileId?: string;
        } | null;
        if (!body?.fileId) return badRequest("fileId is required");

        const file = await env.DB.prepare(
          "SELECT * FROM files WHERE file_id = ? AND client_code = ? AND deleted_at IS NULL",
        )
          .bind(body.fileId, clientCode)
          .first<FileRow>();
        if (!file) return badRequest("File not found", 404);

        if (file.status === "active") {
          const refreshed = await getUser(env.DB, clientCode);
          return json({
            fileId: file.file_id,
            status: "active",
            ...usagePayload(refreshed ?? user),
          });
        }

        const headUrl = await presignUrl({
          method: "HEAD",
          bucket,
          objectKey: file.object_key,
          expiresInSeconds: 120,
        });

        const objectState = await verifyObjectAndReadHeaders(headUrl);
        const nowIso = new Date().toISOString();

        await env.DB.batch([
          env.DB.prepare(
            "UPDATE files SET size_bytes = ?, mime_type = COALESCE(?, mime_type), status = 'active' WHERE file_id = ?",
          ).bind(objectState.sizeBytes, objectState.contentType, file.file_id),
          env.DB.prepare(
            `UPDATE users
             SET used_bytes = used_bytes + ?,
                 uploads_count = uploads_count + 1,
                 last_activity_at = ?
             WHERE client_code = ?`,
          ).bind(objectState.sizeBytes, nowIso, clientCode),
        ]);

        const refreshed = await getUser(env.DB, clientCode);
        return json({
          fileId: file.file_id,
          sizeBytes: objectState.sizeBytes,
          ...usagePayload(refreshed ?? user),
        });
      }

      if (request.method === "GET" && url.pathname === "/files") {
        const rows = await env.DB.prepare(
          `SELECT file_id, object_key, size_bytes, mime_type, created_at
           FROM files
           WHERE client_code = ? AND deleted_at IS NULL AND status = 'active'
           ORDER BY created_at DESC`,
        )
          .bind(clientCode)
          .all();

        return json({ files: rows.results ?? [] });
      }

      const downloadMatch = url.pathname.match(/^\/files\/([^/]+)\/download$/);
      if (request.method === "GET" && downloadMatch) {
        const fileId = downloadMatch[1];
        const file = await env.DB.prepare(
          "SELECT * FROM files WHERE file_id = ? AND client_code = ? AND deleted_at IS NULL AND status = 'active'",
        )
          .bind(fileId, clientCode)
          .first<FileRow>();
        if (!file) return badRequest("File not found", 404);

        const ttl = Number(env.URL_TTL_SECONDS ?? 300);
        const downloadUrl = await presignUrl({
          method: "GET",
          bucket,
          objectKey: file.object_key,
          expiresInSeconds: ttl,
        });

        await env.DB.prepare(
          `UPDATE users
           SET downloads_count = downloads_count + 1,
               last_activity_at = ?
           WHERE client_code = ?`,
        )
          .bind(new Date().toISOString(), clientCode)
          .run();

        return json({
          downloadUrl,
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        });
      }

      const deleteMatch = url.pathname.match(/^\/files\/([^/]+)$/);
      if (request.method === "DELETE" && deleteMatch) {
        const fileId = deleteMatch[1];
        const file = await env.DB.prepare(
          "SELECT * FROM files WHERE file_id = ? AND client_code = ? AND deleted_at IS NULL",
        )
          .bind(fileId, clientCode)
          .first<FileRow>();
        if (!file) return badRequest("File not found", 404);

        const sizeBytes = file.size_bytes ?? 0;
        const nowIso = new Date().toISOString();

        await env.DB.batch([
          env.DB.prepare(
            "UPDATE files SET deleted_at = ?, status = 'deleted' WHERE file_id = ?",
          ).bind(nowIso, file.file_id),
          env.DB.prepare(
            `UPDATE users
             SET used_bytes = CASE WHEN used_bytes > ? THEN used_bytes - ? ELSE 0 END,
                 last_activity_at = ?
             WHERE client_code = ?`,
          ).bind(sizeBytes, sizeBytes, nowIso, clientCode),
        ]);

        const deleteUrl = await presignUrl({
          method: "DELETE",
          bucket,
          objectKey: file.object_key,
          expiresInSeconds: 60,
        });

        ctx.waitUntil(
          fetch(deleteUrl, { method: "DELETE" }).catch(() => undefined),
        );

        const refreshed = await getUser(env.DB, clientCode);
        return json({ deleted: true, ...usagePayload(refreshed ?? user) });
      }

      return badRequest("Not found", 404);
    } catch (error) {
      console.error("[vault-api] unhandled request error", {
        requestId,
        method: request.method,
        path: url.pathname,
        ip,
        error: serializeError(error),
      });

      return json(
        {
          error: "Internal server error",
          requestId,
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
