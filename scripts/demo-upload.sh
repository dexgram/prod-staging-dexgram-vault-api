#!/usr/bin/env bash
set -euo pipefail

# Demo script: login -> request upload URL -> PUT file -> complete upload -> list files
# Usage:
#   ./scripts/demo-upload.sh <client_code> <file_path> [api_base]
# Example:
#   ./scripts/demo-upload.sh "3912607696116670" ./hello.txt
#   ./scripts/demo-upload.sh "3912 6076 9611 6670" ./hello.txt https://prod-vaultdb.dexgram.app

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required" >&2
  exit 1
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <client_code> <file_path> [api_base]" >&2
  exit 1
fi

CLIENT_CODE="$1"
FILE_PATH="$2"
API_BASE="${3:-https://prod-vaultdb.dexgram.app}"

if [[ ! -f "$FILE_PATH" ]]; then
  echo "ERROR: file not found: $FILE_PATH" >&2
  exit 1
fi

# Compute filename metadata and validations done on client side before upload request.
if command -v stat >/dev/null 2>&1; then
  if stat --version >/dev/null 2>&1; then
    SIZE_BYTES="$(stat -c%s "$FILE_PATH")" # GNU stat
  else
    SIZE_BYTES="$(stat -f%z "$FILE_PATH")" # BSD stat
  fi
else
  echo "ERROR: stat is required" >&2
  exit 1
fi

if [[ "$SIZE_BYTES" -le 0 ]]; then
  echo "ERROR: empty file is not allowed" >&2
  exit 1
fi

# Local safety limit for the demo (server has its own MAX_UPLOAD_BYTES check too).
MAX_LOCAL_BYTES=$((100 * 1024 * 1024))
if [[ "$SIZE_BYTES" -gt "$MAX_LOCAL_BYTES" ]]; then
  echo "ERROR: file too large for demo (${SIZE_BYTES} bytes > ${MAX_LOCAL_BYTES} bytes)" >&2
  exit 1
fi

# Best effort mime type detection.
if command -v file >/dev/null 2>&1; then
  MIME_TYPE="$(file --mime-type -b "$FILE_PATH")"
else
  MIME_TYPE="application/octet-stream"
fi

# Very small allowlist for demo purpose.
case "$MIME_TYPE" in
  text/plain|image/jpeg|image/png|application/pdf) ;;
  *)
    echo "ERROR: unsupported MIME type for demo: $MIME_TYPE" >&2
    echo "       Allowed: text/plain, image/jpeg, image/png, application/pdf" >&2
    exit 1
    ;;
esac

echo "==> 1) Login"
LOGIN_RESP="$(curl -sS "$API_BASE/auth/login" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg cc "$CLIENT_CODE" '{clientCode:$cc}')")"

TOKEN="$(echo "$LOGIN_RESP" | jq -r '.token')"
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: login failed" >&2
  echo "$LOGIN_RESP" >&2
  exit 1
fi

echo "    token OK"

echo "==> 2) Request upload URL"
REQUEST_RESP="$(curl -sS "$API_BASE/uploads/request" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg mime "$MIME_TYPE" --argjson size "$SIZE_BYTES" '{mimeType:$mime,sizeBytes:$size}')")"

FILE_ID="$(echo "$REQUEST_RESP" | jq -r '.fileId')"
UPLOAD_URL="$(echo "$REQUEST_RESP" | jq -r '.uploadUrl')"
REQ_CONTENT_TYPE="$(echo "$REQUEST_RESP" | jq -r '.requiredHeaders["content-type"]')"
REQ_CONTENT_LENGTH="$(echo "$REQUEST_RESP" | jq -r '.requiredHeaders["content-length"]')"

if [[ -z "$FILE_ID" || "$FILE_ID" == "null" || -z "$UPLOAD_URL" || "$UPLOAD_URL" == "null" ]]; then
  echo "ERROR: upload request failed" >&2
  echo "$REQUEST_RESP" >&2
  exit 1
fi

echo "    fileId: $FILE_ID"
echo "    required content-type: $REQ_CONTENT_TYPE"
echo "    required content-length: $REQ_CONTENT_LENGTH"

echo "==> 3) Upload binary to presigned URL (PUT)"
UPLOAD_STATUS="$(curl -sS -o /tmp/dexgram_upload_response.txt -w '%{http_code}' -X PUT "$UPLOAD_URL" \
  -H "content-type: $REQ_CONTENT_TYPE" \
  -H "content-length: $REQ_CONTENT_LENGTH" \
  --data-binary "@$FILE_PATH")"

if [[ "$UPLOAD_STATUS" != "200" ]]; then
  echo "ERROR: binary upload failed with HTTP $UPLOAD_STATUS" >&2
  cat /tmp/dexgram_upload_response.txt >&2
  exit 1
fi

echo "    upload PUT OK"

echo "==> 4) Complete upload in API"
COMPLETE_STATUS="$(curl -sS -o /tmp/dexgram_complete_response.txt -w '%{http_code}' "$API_BASE/uploads/complete" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg fid "$FILE_ID" '{fileId:$fid}')")"

COMPLETE_RESP="$(cat /tmp/dexgram_complete_response.txt)"

if [[ "$COMPLETE_STATUS" != "200" ]]; then
  echo "ERROR: complete failed with HTTP $COMPLETE_STATUS" >&2
  echo "$COMPLETE_RESP" >&2
  exit 1
fi

STATUS="$(echo "$COMPLETE_RESP" | jq -r '.status // empty')"
if [[ "$STATUS" == "active" ]]; then
  echo "    complete OK (status=active)"
elif [[ "$(echo "$COMPLETE_RESP" | jq -r '.sizeBytes // empty')" != "" ]]; then
  echo "    complete OK (activated now)"
else
  echo "ERROR: complete failed" >&2
  echo "$COMPLETE_RESP" >&2
  exit 1
fi
echo "    complete response: $COMPLETE_RESP"

echo "==> 5) List files"
LIST_RESP="$(curl -sS "$API_BASE/files" -H "authorization: Bearer $TOKEN")"

echo "$LIST_RESP" | jq .

echo
echo "Demo finished successfully."
