export interface SessionPayload {
  clientCode: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = atob(`${normalized}${padding}`);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function toUtf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function fromUtf8Bytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export async function signSessionToken(payload: SessionPayload, secret: string): Promise<string> {
  const payloadPart = base64UrlEncode(toUtf8Bytes(JSON.stringify(payload)));
  const signingInput = `v1.${payloadPart}`;
  const key = await crypto.subtle.importKey(
    "raw",
    toUtf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, toUtf8Bytes(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
  const [version, payloadPart, signaturePart] = token.split(".");
  if (version !== "v1" || !payloadPart || !signaturePart) return null;

  const signingInput = `v1.${payloadPart}`;
  const key = await crypto.subtle.importKey(
    "raw",
    toUtf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(signaturePart),
    toUtf8Bytes(signingInput)
  );
  if (!valid) return null;

  const payload = JSON.parse(fromUtf8Bytes(base64UrlDecode(payloadPart))) as SessionPayload;
  const now = Math.floor(Date.now() / 1000);
  return payload.exp > now ? payload : null;
}
