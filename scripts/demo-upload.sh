#!/usr/bin/env bash
set -euo pipefail

# Multi-action demo script:
# - upload (default): login -> request upload URL -> PUT -> complete -> list
# - replace: overwrite an existing file_id with new bytes
# - delete: delete a file by file_id
# - usage: show per-client occupied space
# - list: list active files
#
# Usage examples:
#   ./scripts/demo-upload.sh upload 3912607696116670 ./hello.txt
#   ./scripts/demo-upload.sh replace 3912607696116670 ./new.txt --file-id <uuid>
#   ./scripts/demo-upload.sh usage 3912607696116670
#   ./scripts/demo-upload.sh list 3912607696116670
#   ./scripts/demo-upload.sh delete 3912607696116670 --file-id <uuid>

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required" >&2
  exit 1
fi

action="${1:-upload}"
if [[ "$action" != "upload" && "$action" != "replace" && "$action" != "delete" && "$action" != "usage" && "$action" != "list" ]]; then
  set -- "upload" "$@"
  action="upload"
fi

shift || true

CLIENT_CODE="${1:-}"
if [[ -z "$CLIENT_CODE" ]]; then
  echo "Usage:" >&2
  echo "  $0 [upload] <client_code> <file_path> [api_base]" >&2
  echo "  $0 replace <client_code> <file_path> --file-id <uuid> [api_base]" >&2
  echo "  $0 delete <client_code> --file-id <uuid> [api_base]" >&2
  echo "  $0 usage <client_code> [api_base]" >&2
  echo "  $0 list <client_code> [api_base]" >&2
  exit 1
fi
shift || true

FILE_PATH=""
FILE_ID=""
API_BASE="https://prod-vaultdb.dexgram.app"

# Parse remaining args: optional file path, optional --file-id, optional api_base.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file-id)
      FILE_ID="${2:-}"
      shift 2
      ;;
    http://*|https://*)
      API_BASE="$1"
      shift
      ;;
    *)
      if [[ -z "$FILE_PATH" ]]; then
        FILE_PATH="$1"
      else
        API_BASE="$1"
      fi
      shift
      ;;
  esac
done

compute_size() {
  local path="$1"
  if command -v stat >/dev/null 2>&1; then
    if stat --version >/dev/null 2>&1; then
      stat -c%s "$path"
    else
      stat -f%z "$path"
    fi
  else
    echo "ERROR: stat is required" >&2
    exit 1
  fi
}

detect_mime() {
  local path="$1"
  if command -v file >/dev/null 2>&1; then
    file --mime-type -b "$path"
  else
    echo "application/octet-stream"
  fi
}

login() {
  local resp token
  echo "==> Login"
  resp="$(curl -sS "$API_BASE/auth/login" \
    -H 'content-type: application/json' \
    -d "$(jq -nc --arg cc "$CLIENT_CODE" '{clientCode:$cc}')")"

  token="$(echo "$resp" | jq -r '.token')"
  if [[ -z "$token" || "$token" == "null" ]]; then
    echo "ERROR: login failed" >&2
    echo "$resp" >&2
    exit 1
  fi

  echo "    token OK"
  TOKEN="$token"
}

request_upload() {
  local token="$1"
  local mime="$2"
  local size="$3"

  curl -sS "$API_BASE/uploads/request" \
    -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -d "$(jq -nc --arg mime "$mime" --argjson size "$size" '{mimeType:$mime,sizeBytes:$size}')"
}

put_binary() {
  local url="$1"
  local content_type="$2"
  local content_length="$3"
  local file_path="$4"

  local status
  status="$(curl -sS -o /tmp/dexgram_upload_response.txt -w '%{http_code}' -X PUT "$url" \
    -H "content-type: $content_type" \
    -H "content-length: $content_length" \
    --data-binary "@$file_path")"

  if [[ "$status" != "200" ]]; then
    echo "ERROR: binary upload failed with HTTP $status" >&2
    cat /tmp/dexgram_upload_response.txt >&2
    exit 1
  fi
}

complete_upload() {
  local token="$1"
  local file_id="$2"

  local status resp
  status="$(curl -sS -o /tmp/dexgram_complete_response.txt -w '%{http_code}' "$API_BASE/uploads/complete" \
    -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -d "$(jq -nc --arg fid "$file_id" '{fileId:$fid}')")"

  resp="$(cat /tmp/dexgram_complete_response.txt)"
  if [[ "$status" != "200" ]]; then
    echo "ERROR: complete failed with HTTP $status" >&2
    echo "$resp" >&2
    exit 1
  fi

  echo "$resp"
}

if [[ "$action" == "upload" || "$action" == "replace" ]]; then
  if [[ -z "$FILE_PATH" || ! -f "$FILE_PATH" ]]; then
    echo "ERROR: file path is required and must exist for '$action'" >&2
    exit 1
  fi
fi

if [[ "$action" == "delete" || "$action" == "replace" ]]; then
  if [[ -z "$FILE_ID" ]]; then
    echo "ERROR: --file-id <uuid> is required for '$action'" >&2
    exit 1
  fi
fi

TOKEN=""
login

case "$action" in
  upload)
    SIZE_BYTES="$(compute_size "$FILE_PATH")"
    MIME_TYPE="$(detect_mime "$FILE_PATH")"

    echo "==> Request upload URL"
    REQUEST_RESP="$(request_upload "$TOKEN" "$MIME_TYPE" "$SIZE_BYTES")"
    FILE_ID_CREATED="$(echo "$REQUEST_RESP" | jq -r '.fileId')"
    UPLOAD_URL="$(echo "$REQUEST_RESP" | jq -r '.uploadUrl')"
    REQ_CONTENT_TYPE="$(echo "$REQUEST_RESP" | jq -r '.requiredHeaders["content-type"]')"
    REQ_CONTENT_LENGTH="$(echo "$REQUEST_RESP" | jq -r '.requiredHeaders["content-length"]')"

    if [[ -z "$FILE_ID_CREATED" || "$FILE_ID_CREATED" == "null" || -z "$UPLOAD_URL" || "$UPLOAD_URL" == "null" ]]; then
      echo "ERROR: upload request failed" >&2
      echo "$REQUEST_RESP" >&2
      exit 1
    fi

    echo "    fileId: $FILE_ID_CREATED"
    put_binary "$UPLOAD_URL" "$REQ_CONTENT_TYPE" "$REQ_CONTENT_LENGTH" "$FILE_PATH"
    echo "    upload PUT OK"

    echo "==> Complete upload"
    COMPLETE_RESP="$(complete_upload "$TOKEN" "$FILE_ID_CREATED")"
    echo "    $COMPLETE_RESP"

    echo "==> List files"
    curl -sS "$API_BASE/files" -H "authorization: Bearer $TOKEN" | jq .
    ;;

  replace)
    SIZE_BYTES="$(compute_size "$FILE_PATH")"
    MIME_TYPE="$(detect_mime "$FILE_PATH")"

    echo "==> Request replace upload URL"
    REQUEST_RESP="$(curl -sS "$API_BASE/files/$FILE_ID/replace/request" \
      -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' \
      -d "$(jq -nc --arg mime "$MIME_TYPE" --argjson size "$SIZE_BYTES" '{mimeType:$mime,sizeBytes:$size}')")"

    UPLOAD_URL="$(echo "$REQUEST_RESP" | jq -r '.uploadUrl')"
    REQ_CONTENT_TYPE="$(echo "$REQUEST_RESP" | jq -r '.requiredHeaders["content-type"]')"
    REQ_CONTENT_LENGTH="$(echo "$REQUEST_RESP" | jq -r '.requiredHeaders["content-length"]')"

    if [[ -z "$UPLOAD_URL" || "$UPLOAD_URL" == "null" ]]; then
      echo "ERROR: replace request failed" >&2
      echo "$REQUEST_RESP" >&2
      exit 1
    fi

    put_binary "$UPLOAD_URL" "$REQ_CONTENT_TYPE" "$REQ_CONTENT_LENGTH" "$FILE_PATH"
    echo "    replace upload PUT OK"

    echo "==> Complete replace"
    curl -sS -X POST "$API_BASE/files/$FILE_ID/replace/complete" \
      -H "authorization: Bearer $TOKEN" | jq .
    ;;

  usage)
    echo "==> Usage"
    curl -sS "$API_BASE/usage" -H "authorization: Bearer $TOKEN" | jq .
    ;;

  list)
    echo "==> List files"
    curl -sS "$API_BASE/files" -H "authorization: Bearer $TOKEN" | jq .
    ;;

  delete)
    echo "==> Delete file"
    curl -sS -X DELETE "$API_BASE/files/$FILE_ID" \
      -H "authorization: Bearer $TOKEN" | jq .
    ;;
esac

echo
echo "Done."
