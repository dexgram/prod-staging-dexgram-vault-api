interface Entry {
  count: number;
  resetAt: number;
}

const state = new Map<string, Entry>();

export function hitRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = state.get(key);

  if (!entry || entry.resetAt <= now) {
    state.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  entry.count += 1;
  return entry.count > maxRequests;
}
