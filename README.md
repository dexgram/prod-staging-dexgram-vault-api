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
- Indexed bucket secrets (no JSON). For each bucket slot `N` (1..20), configure:
  - `BUCKET_ID_N` (must match `users.bucket_id` in D1)
  - `BUCKET_NAME_N`
  - `BUCKET_ENDPOINT_N`
  - `BUCKET_REGION_N`
  - `BUCKET_ACCESS_KEY_N`
  - `BUCKET_SECRET_KEY_N`

Example for one bucket:

```bash
BUCKET_ID_1=b2-us-west-1
BUCKET_NAME_1=dexgram-vault-001
BUCKET_ENDPOINT_1=https://s3.us-west-000.backblazeb2.com
BUCKET_REGION_1=us-west-001
BUCKET_ACCESS_KEY_1=...
BUCKET_SECRET_KEY_1=...
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
   npx wrangler secret put BUCKET_ID_1
   npx wrangler secret put BUCKET_NAME_1
   npx wrangler secret put BUCKET_ENDPOINT_1
   npx wrangler secret put BUCKET_REGION_1
   npx wrangler secret put BUCKET_ACCESS_KEY_1
   npx wrangler secret put BUCKET_SECRET_KEY_1
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

### 6) Replace/overwrite an existing file

`POST /files/:fileId/replace/request` (auth required)

Body:
```json
{ "mimeType": "text/plain", "sizeBytes": 2048 }
```

Returns a presigned PUT URL targeting the existing object key for that `fileId`.

Then call:

`POST /files/:fileId/replace/complete` (auth required)

Worker verifies the new object and updates usage (`used_bytes`) using the size delta.

### 7) Get client usage

`GET /usage` (auth required)

Returns:
- `usedBytes` (tracked counter in `users`)
- `actualActiveBytes` (sum of active file sizes in `files`)
- `activeFilesCount`

### 8) Delete file

`DELETE /files/:fileId` (auth required)

Yes: delete is done by `fileId`. The API marks row as deleted, decrements `used_bytes`, and attempts async object deletion from storage.

## Example cURL

```bash
# 1) Login
TOKEN=$(curl -s https://prod-vaultdb.dexgram.app/auth/login \
  -H 'content-type: application/json' \
  -d '{"clientCode":"3912 6076 9611 6679"}' | jq -r .token)

# 2) Request upload URL
curl -s https://prod-vaultdb.dexgram.app/uploads/request \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"mimeType":"image/jpeg","sizeBytes":1024}'

# 3) List files
curl -s https://prod-vaultdb.dexgram.app/files \
  -H "authorization: Bearer $TOKEN"

# 4) Usage by client
curl -s https://prod-vaultdb.dexgram.app/usage \
  -H "authorization: Bearer $TOKEN"

# 5) Delete one file by file_id
curl -s -X DELETE https://prod-vaultdb.dexgram.app/files/<file_id> \
  -H "authorization: Bearer $TOKEN"

# 6) Overwrite a file (same file_id)
REPLACE=$(curl -s https://prod-vaultdb.dexgram.app/files/<file_id>/replace/request \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"mimeType":"text/plain","sizeBytes":15}')

UPLOAD_URL=$(echo "$REPLACE" | jq -r '.uploadUrl')
CT=$(echo "$REPLACE" | jq -r '.requiredHeaders["content-type"]')
CL=$(echo "$REPLACE" | jq -r '.requiredHeaders["content-length"]')

curl -s -X PUT "$UPLOAD_URL" \
  -H "content-type: $CT" \
  -H "content-length: $CL" \
  --data-binary '@./toto.txt'

curl -s -X POST https://prod-vaultdb.dexgram.app/files/<file_id>/replace/complete \
  -H "authorization: Bearer $TOKEN"
```

## Demo script: upload / replace / usage / delete

Yes: the client should validate file metadata **before** requesting a presigned upload URL.

- detect/choose `mimeType`
- compute exact `sizeBytes`
- apply local product rules (e.g. max size, allowed types)

The API also revalidates plan/quota/subscription and returns the exact signed headers required for PUT (`content-type`, `content-length`).

Use the included demo script to run the full flow from start to finish:

```bash
# create a small demo file
echo -n "hello world!" > hello.txt

# run end-to-end demo
./scripts/demo-upload.sh upload "3912607696116670" ./hello.txt

# show usage
./scripts/demo-upload.sh usage "3912607696116670"

# overwrite an existing file_id
./scripts/demo-upload.sh replace "3912607696116670" ./hello-v2.txt --file-id <file_id>

# delete by file_id
./scripts/demo-upload.sh delete "3912607696116670" --file-id <file_id>
```

What the script does:

1. validates local file (exists, size > 0, basic MIME allowlist)
2. logs in (`POST /auth/login`)
3. requests upload URL (`POST /uploads/request`)
4. uploads file bytes to `uploadUrl` with required headers (PUT)
5. completes upload (`POST /uploads/complete`)
6. lists files (`GET /files`)

## Troubleshooting

### `error code: 1101` on Cloudflare

Cloudflare `1101` means the Worker crashed with an unhandled runtime exception.
In this project, common causes are:

- missing or incomplete indexed bucket secrets (`BUCKET_ID_N`, `BUCKET_NAME_N`, `BUCKET_ENDPOINT_N`, `BUCKET_REGION_N`, `BUCKET_ACCESS_KEY_N`, `BUCKET_SECRET_KEY_N`)
- missing/misconfigured `DB` binding
- unexpected data shape from D1 that triggers an exception

Useful commands:

```bash
# stream production logs to see the real stack trace
npx wrangler tail --env prod

# verify secrets exist
npx wrangler secret list --env prod
```

### Add/update a user manually with Wrangler (D1)

`users.client_code` is stored as digits only (`3912607696116679`, without spaces).

```bash
# create or update a user in production
npx wrangler d1 execute prod-dexgram-vault-db --remote --command "
INSERT INTO users (client_code, bucket_id, quota_gb, subscription_expires_at)
VALUES ('3912607696116679', 'wasabi-eu-1', 20, '2026-12-31T23:59:59.000Z')
ON CONFLICT(client_code) DO UPDATE SET
  bucket_id = excluded.bucket_id,
  quota_gb = excluded.quota_gb,
  subscription_expires_at = excluded.subscription_expires_at;
"

# verify
npx wrangler d1 execute prod-dexgram-vault-db --remote --command "
SELECT client_code, bucket_id, quota_gb, used_bytes, subscription_expires_at
FROM users
WHERE client_code = '3912607696116679';
"
```

## GitHub Actions secret injection

In CI/CD, the workflow `.github/workflows/deploy-prod.yml` syncs GitHub secrets to Cloudflare on every deploy.

Configure these GitHub secrets in the `prod` environment:

- `wrangler secret put SESSION_SECRET`
- `wrangler secret put BUCKET_ID_1`
- `wrangler secret put BUCKET_NAME_1`
- `wrangler secret put BUCKET_ENDPOINT_1`
- `wrangler secret put BUCKET_REGION_1`
- `wrangler secret put BUCKET_ACCESS_KEY_1`
- `wrangler secret put BUCKET_SECRET_KEY_1`

For additional bucket slots, duplicate the same pattern (`_2`, `_3`, etc.) in both GitHub environment secrets and workflow sync steps.
