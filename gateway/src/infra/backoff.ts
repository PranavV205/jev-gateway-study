export interface BackoffPolicy {
  backoffInitialMs: number;
  backoffMaxMs: number;
}

// Exponential backoff with full jitter: a random wait between 0 and the capped exponential delay.
export function backoffMs(attempt: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const cap = Math.min(policy.backoffMaxMs, policy.backoffInitialMs * 2 ** attempt);
  return Math.round(random() * cap);
}

// Parses a Retry-After header (seconds or an HTTP date) into milliseconds, or null.
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
