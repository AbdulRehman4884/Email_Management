/**
 * In-process rate limiters (p-queue):
 *   - per host: 1 request every 2 seconds (use case UC-04), so a crawl never hammers one website
 *   - per source: sources.rate_per_min spread evenly (Nominatim needs <= 1 request per second)
 * Limits are per worker process; the daily caps in source_daily_usage hold across processes.
 */
import PQueue from 'p-queue';
import { HOST_INTERVAL_MS } from './config.js';

const MAX_IDLE_QUEUES = 500;
const hostQueues = new Map<string, PQueue>();
const sourceQueues = new Map<string, { queue: PQueue; ratePerMin: number }>();

function dropIdle(map: Map<string, PQueue>): void {
  if (map.size <= MAX_IDLE_QUEUES) return;
  for (const [key, q] of map) {
    if (q.size === 0 && q.pending === 0) map.delete(key);
    if (map.size <= MAX_IDLE_QUEUES / 2) break;
  }
}

/** Runs `fn` when this host's turn comes (max 1 start every `intervalMs`, one at a time). */
export function scheduleForHost<T>(host: string, fn: () => Promise<T>, intervalMs = HOST_INTERVAL_MS): Promise<T> {
  const key = host.toLowerCase();
  let q = hostQueues.get(key);
  if (!q) {
    dropIdle(hostQueues);
    q = new PQueue({ concurrency: 1, interval: intervalMs, intervalCap: 1 });
    hostQueues.set(key, q);
  }
  return q.add(fn) as Promise<T>;
}

/** Runs `fn` within the source's requests-per-minute budget. No limit when ratePerMin is null/0. */
export function scheduleForSource<T>(code: string, ratePerMin: number | null, fn: () => Promise<T>): Promise<T> {
  if (!ratePerMin || ratePerMin <= 0) return fn();
  let entry = sourceQueues.get(code);
  if (!entry || entry.ratePerMin !== ratePerMin) {
    entry = { queue: new PQueue({ concurrency: 4, interval: Math.ceil(60_000 / ratePerMin), intervalCap: 1 }), ratePerMin };
    sourceQueues.set(code, entry);
  }
  return entry.queue.add(fn) as Promise<T>;
}

/** Tests only. */
export function resetRateLimiters(): void {
  hostQueues.clear();
  sourceQueues.clear();
}
