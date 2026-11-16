/**
 * In-memory fixed-window rate limit for the public endpoints that need no login
 * (website tracking, form submits). Counted per API process.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();
let lastSweep = 0;

/** True when this hit is allowed: at most `max` hits per `windowMs` for `key`. */
export function allowHit(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

/** Hits counted for `key` in its current window (0 when none or expired). Does not count a hit. */
export function hitCount(key: string): number {
  const bucket = buckets.get(key);
  return bucket && bucket.resetAt > Date.now() ? bucket.count : 0;
}

/** Seconds until the window for `key` resets (0 when none). */
export function secondsUntilReset(key: string): number {
  const bucket = buckets.get(key);
  return bucket ? Math.max(0, Math.ceil((bucket.resetAt - Date.now()) / 1000)) : 0;
}

export function clearHits(key: string): void {
  buckets.delete(key);
}
