const CLIENT_CODE_PATTERN = /^\d{16}$/;

export function normalizeClientCode(input: string): string {
  return input.replace(/\s+/g, "").trim();
}

export function parseClientCode(input: string): string | null {
  const normalized = normalizeClientCode(input);
  return CLIENT_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function userPrefix(clientCode: string): string {
  return `_${clientCode}`;
}
