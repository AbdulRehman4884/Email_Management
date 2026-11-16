/**
 * SQL helpers shared by the Lead Engine tracks (collectors, worker, API).
 * Every function takes an optional `q` (a pool client inside a transaction); default is the pool.
 * User-facing queries always filter by the token user's id; master data has no user id.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { dbPool } from '../db.js';
import { hashIdentifier, type IdentifierType } from './normalize.js';
import type { SourceRow } from './types.js';

export type Queryable = Pick<Pool | PoolClient, 'query'>;

// ── leadgen_cache ────────────────────────────────────────────────────────────

/** Cache keys are varchar(300); long keys are shortened with a hash so they always fit. */
export function cacheKey(...parts: Array<string | number>): string {
  const key = parts.join(':');
  if (key.length <= 300) return key;
  return `${key.slice(0, 200)}#${createHash('sha256').update(key).digest('hex')}`;
}

export async function cacheGet<T>(key: string, q: Queryable = dbPool): Promise<T | null> {
  const r = await q.query<{ payload: T }>(`SELECT payload FROM leadgen_cache WHERE cache_key = $1 AND expires_at > now()`, [key]);
  return r.rows[0]?.payload ?? null;
}

export async function cacheSet(key: string, payload: unknown, ttlMs: number, q: Queryable = dbPool): Promise<void> {
  await q.query(
    `INSERT INTO leadgen_cache (cache_key, payload, expires_at)
     VALUES ($1, $2::jsonb, now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
    [key, JSON.stringify(payload), String(Math.max(0, Math.round(ttlMs)))]
  );
}

/** Daily cleanup. Returns the number of rows removed. */
export async function purgeExpiredCache(q: Queryable = dbPool): Promise<number> {
  const r = await q.query(`DELETE FROM leadgen_cache WHERE expires_at <= now()`);
  return r.rowCount ?? 0;
}

// ── sources ──────────────────────────────────────────────────────────────────

const SOURCE_COLUMNS = `id, code, type, is_enabled AS "isEnabled", rate_per_min AS "ratePerMin", daily_cap AS "dailyCap",
  notes, cooldown_until AS "cooldownUntil"`;

export async function listSources(q: Queryable = dbPool): Promise<SourceRow[]> {
  return (await q.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources ORDER BY id`)).rows;
}

export async function getSourceByCode(code: string, q: Queryable = dbPool): Promise<SourceRow | null> {
  return (await q.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE code = $1`, [code])).rows[0] ?? null;
}

export interface SourceUsage {
  requestsUsed: number;
  blockedCount: number;
}

export async function getSourceUsageToday(sourceId: number, q: Queryable = dbPool): Promise<SourceUsage> {
  const r = await q.query<SourceUsage>(
    `SELECT requests_used AS "requestsUsed", blocked_count AS "blockedCount" FROM source_daily_usage WHERE source_id = $1 AND day = current_date`,
    [sourceId]
  );
  return r.rows[0] ?? { requestsUsed: 0, blockedCount: 0 };
}

/** Counts `n` requests for today and returns today's total. */
export async function recordSourceRequests(sourceId: number, n = 1, q: Queryable = dbPool): Promise<number> {
  const r = await q.query<{ requests_used: number }>(
    `INSERT INTO source_daily_usage (source_id, day, requests_used) VALUES ($1, current_date, $2)
     ON CONFLICT (source_id, day) DO UPDATE SET requests_used = source_daily_usage.requests_used + EXCLUDED.requests_used
     RETURNING requests_used`,
    [sourceId, n]
  );
  return r.rows[0]?.requests_used ?? n;
}

/** Blocks in one day after which the source stays off until tomorrow (use case UC-13). */
export const MAX_BLOCKS_PER_DAY = 20;
/** Cooldown after one 429/403/CAPTCHA. */
export const BLOCK_COOLDOWN_MS = 60 * 60_000;

/**
 * Records a 429/403/CAPTCHA: +1 blocked_count today and a cooldown (1 hour, or until tomorrow
 * once MAX_BLOCKS_PER_DAY is reached). Returns the cooldown end and whether the source is off for the day.
 */
export async function recordSourceBlock(
  sourceId: number,
  retryAfterMs: number | null = null,
  q: Queryable = dbPool
): Promise<{ blockedToday: number; cooldownUntil: string; offForToday: boolean }> {
  const usage = await q.query<{ blocked_count: number }>(
    `INSERT INTO source_daily_usage (source_id, day, blocked_count) VALUES ($1, current_date, 1)
     ON CONFLICT (source_id, day) DO UPDATE SET blocked_count = source_daily_usage.blocked_count + 1
     RETURNING blocked_count`,
    [sourceId]
  );
  const blockedToday = usage.rows[0]?.blocked_count ?? 1;
  const offForToday = blockedToday >= MAX_BLOCKS_PER_DAY;
  const cooldownMs = Math.max(BLOCK_COOLDOWN_MS, retryAfterMs ?? 0);
  const r = await q.query<{ cooldown_until: string }>(
    `UPDATE sources SET cooldown_until = GREATEST(COALESCE(cooldown_until, now()),
        CASE WHEN $2 THEN (current_date + 1)::timestamptz ELSE now() + ($3 || ' milliseconds')::interval END)
      WHERE id = $1 RETURNING cooldown_until`,
    [sourceId, offForToday, String(cooldownMs)]
  );
  return { blockedToday, cooldownUntil: r.rows[0]?.cooldown_until ?? '', offForToday };
}

export type SourceAvailability = { ok: true } | { ok: false; reason: 'disabled' | 'cooldown' | 'daily_cap'; until: string | null };

/** Can the source be used right now? (enabled, no cooldown, under today's cap) */
export async function sourceAvailability(source: SourceRow, q: Queryable = dbPool): Promise<SourceAvailability> {
  if (!source.isEnabled) return { ok: false, reason: 'disabled', until: null };
  const r = await q.query<{ cooling: boolean; used: number }>(
    `SELECT (s.cooldown_until IS NOT NULL AND s.cooldown_until > now()) AS cooling,
            COALESCE(u.requests_used, 0) AS used
       FROM sources s LEFT JOIN source_daily_usage u ON u.source_id = s.id AND u.day = current_date
      WHERE s.id = $1`,
    [source.id]
  );
  const row = r.rows[0];
  if (row?.cooling) return { ok: false, reason: 'cooldown', until: source.cooldownUntil };
  if (source.dailyCap != null && (row?.used ?? 0) >= source.dailyCap) return { ok: false, reason: 'daily_cap', until: null };
  return { ok: true };
}

// ── compliance ───────────────────────────────────────────────────────────────

/**
 * True if any of the identifiers (email, domain, LinkedIn URL) is in do_not_collect.
 * Called before inserting a company, person, contact point or social profile.
 */
export async function isDoNotCollect(
  identifiers: Array<{ type: IdentifierType; value: string | null | undefined }>,
  q: Queryable = dbPool
): Promise<boolean> {
  const hashes = identifiers
    .map((i) => (i.value ? hashIdentifier(i.type, i.value) : null))
    .filter((h): h is string => h !== null);
  if (hashes.length === 0) return false;
  const r = await q.query(`SELECT 1 FROM do_not_collect WHERE identifier_hash = ANY($1::char(64)[]) LIMIT 1`, [hashes]);
  return (r.rowCount ?? 0) > 0;
}

/** Adds the identifier's hash to do_not_collect (no-op if it is already there or cannot be normalized). */
export async function addDoNotCollect(type: IdentifierType, value: string, q: Queryable = dbPool): Promise<boolean> {
  const hash = hashIdentifier(type, value);
  if (!hash) return false;
  await q.query(
    `INSERT INTO do_not_collect (identifier_hash, identifier_type) VALUES ($1, $2) ON CONFLICT (identifier_hash) DO NOTHING`,
    [hash, type]
  );
  return true;
}

// ── quotas ───────────────────────────────────────────────────────────────────

/** Use case section 12 defaults. The daily lead limit comes from plans.lead_gen_daily_limit. */
export const MAX_ACTIVE_SEARCHES = 10;
export const MAX_CONCURRENT_RUNS = 2;

/** New workspace leads the user got today, "today" in the given IANA timezone. */
export async function countLeadsFoundToday(userId: number, timezone: string, q: Queryable = dbPool): Promise<number> {
  const r = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM workspace_leads
      WHERE user_id = $1 AND found_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [userId, timezone]
  );
  return r.rows[0]?.n ?? 0;
}

/** Runs of the user that are queued or running. */
export async function countActiveRuns(userId: number, q: Queryable = dbPool): Promise<{ running: number; queued: number }> {
  const r = await q.query<{ running: number; queued: number }>(
    `SELECT count(*) FILTER (WHERE status = 'running')::int AS running, count(*) FILTER (WHERE status = 'queued')::int AS queued
       FROM scrape_runs WHERE user_id = $1 AND status IN ('queued', 'running')`,
    [userId]
  );
  return r.rows[0] ?? { running: 0, queued: 0 };
}

// ── notifications ────────────────────────────────────────────────────────────

/** Bell notification (user_notifications), e.g. 'leadgen_run_done', 'leadgen_schedule_paused'. */
export async function notifyUser(userId: number, type: string, payload: Record<string, unknown>, q: Queryable = dbPool): Promise<void> {
  await q.query(`INSERT INTO user_notifications (user_id, type, payload) VALUES ($1, $2, $3::jsonb)`, [userId, type, JSON.stringify(payload)]);
}

/** Bell notification for every admin / super_admin (source blocked for the day, etc.). */
export async function notifyAdmins(type: string, payload: Record<string, unknown>, q: Queryable = dbPool): Promise<void> {
  await q.query(
    `INSERT INTO user_notifications (user_id, type, payload)
     SELECT id, $1, $2::jsonb FROM users WHERE role IN ('admin', 'super_admin')`,
    [type, JSON.stringify(payload)]
  );
}
