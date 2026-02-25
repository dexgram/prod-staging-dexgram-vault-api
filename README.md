# Dexgram Vault API (Cloudflare Worker + D1)

Multi-tenant storage API for mobile clients that need secure uploads/downloads to S3-compatible object stores (Wasabi, Backblaze B2 S3 API, etc.) without embedding long-term S3 credentials in apps.

## Features

- **Client-code login** (`POST /auth/login`) using 16-digit codes with or without spaces.
- **Signed session token** (HMAC) for authenticated calls.
- **Bucket sharding per user** via `bucket_id` in D1 and bucket config from environment secrets.
- **Presigned S3 URLs** for uploads/downloads with short expiration.
- **Quota/subscription enforcement** before upload authorization.
- **Metadata + usage tracking** in D1 (`used_bytes`, upload/download counters, file index).
- **No long-term S3 credentials in mobile app.**

## Project layout

- `src/index.ts` - Worker API and auth middleware.
- `src/utils/clientCode.ts` - client code normalization/parsing helper.
- `src/utils/token.ts` - HMAC token signing/verification.
- `src/utils/s3.ts` - AWS SigV4 presigning for custom S3 endpoints.
- `migrations/0001_initial.sql` - D1 schema.
- `wrangler.toml.example` - Wrangler template (no secrets).

## D1 schema

Apply migrations from `migrations/` (see commands below). Core tables:

- `users`
  - `client_code` (digits-only, PK)
  - `bucket_id`
  - `quota_gb`
  - `used_bytes`, `uploads_count`, `downloads_count`, `last_activity_at`
  - `subscription_expires_at`
- `files`
  - `file_id` (uuid, PK)
  - `client_code`
  - `object_key`
  - `size_bytes`, `mime_type`
  - `status` (`pending`/`active`/`deleted`)
  - `created_at`, `deleted_at`

## Environment variables / secrets

Set with Worker secrets or GitHub Actions secrets:

- `SESSION_SECRET`: random long HMAC secret for session tokens.
- `BUCKET_CONFIGS_JSON`: array of bucket configs:

```json
[
  {
    "id": "wasabi-eu-1",
    "bucketName": "my-app-bucket-1",
    "endpoint": "https://s3.eu-central-1.wasabisys.com",
    "region": "eu-central-1",
    "accessKey": "...",
    "secretKey": "..."
  },
  {
    "id": "b2-us-west-1",
    "bucketName": "my-app-bucket-2",
    "endpoint": "https://s3.us-west-001.backblazeb2.com",
    "region": "us-west-001",
    "accessKey": "...",
    "secretKey": "..."
  }
]
```

Optional non-secret vars:

- `TOKEN_TTL_SECONDS` (default `86400`)
- `URL_TTL_SECONDS` (default `300`)
- `MAX_UPLOAD_BYTES` (default `5368709120`)
- `RATE_LIMIT_MAX_REQUESTS` (default `60`)
- `RATE_LIMIT_WINDOW_MS` (default `60000`)

## Local development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy template:
   ```bash
   cp wrangler.toml.example wrangler.toml
   ```
3. Create D1 DB and set `database_id` in `wrangler.toml`.
4. Apply migrations locally:
   ```bash
   npx wrangler d1 migrations apply dexgram-vault --local
   ```
5. Add secrets:
   ```bash
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put BUCKET_CONFIGS_JSON
   ```
6. Run Worker:
   ```bash
   npm run dev
   ```

## API

### 1) Login

`POST /auth/login`

Body:
```json
{ "clientCode": "3912 6076 9611 6679" }
```

Returns token + usage stats. Login is allowed even if subscription is expired; uploads are restricted by `/uploads/request`.

### 2) Request upload URL

`POST /uploads/request` (auth required)

Body:
```json
{ "mimeType": "image/jpeg", "sizeBytes": 98304 }
```

Returns:

- `fileId`
- `objectKey` (always `_digits/yyyy/mm/uuid`)
- short-lived `uploadUrl` (presigned PUT)
- required headers (`content-type`, `content-length`)

### 3) Complete upload

`POST /uploads/complete` (auth required)

Body:
```json
{ "fileId": "uuid" }
```

Worker verifies object exists via `HEAD`, finalizes metadata, updates counters.

### 4) List files

`GET /files` (auth required)

Returns file list from D1 only.

### 5) Request download URL

`GET /files/:fileId/download` (auth required)

Returns short-lived presigned GET URL and increments `downloads_count`.

### 6) Delete file

`DELETE /files/:fileId` (auth required)

Marks row as deleted, decrements `used_bytes`, and attempts async object deletion from storage.

## Example cURL

```bash
# 1) Login
TOKEN=$(curl -s http://127.0.0.1:8787/auth/login \
  -H 'content-type: application/json' \
  -d '{"clientCode":"3912 6076 9611 6679"}' | jq -r .token)

# 2) Request upload URL
curl -s http://127.0.0.1:8787/uploads/request \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"mimeType":"image/jpeg","sizeBytes":1024}'

# 3) List files
curl -s http://127.0.0.1:8787/files \
  -H "authorization: Bearer $TOKEN"
```

## GitHub Actions secret injection

In CI/CD, inject secrets as environment variables / Worker secrets before deploy:

- `wrangler secret put SESSION_SECRET`
- `wrangler secret put BUCKET_CONFIGS_JSON`

You can store encrypted values in GitHub repository secrets and pipe them to Wrangler during deployment.
