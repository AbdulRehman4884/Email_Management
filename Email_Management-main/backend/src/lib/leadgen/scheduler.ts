/**
 * Run lifecycle (use case UC-03, section 8):
 *   tickScheduler     due schedules -> one queued run per schedule per day, next_run_at moved on
 *   startQueuedRuns   queued -> running (max 2 per user, daily quota), discover task per source
 *   finalizeRuns      running runs without open tasks -> done / partial / failed, schedule bookkeeping, bell
 * Every step is safe with several worker processes: rows are locked with FOR UPDATE SKIP LOCKED,
 * scrape_runs has UNIQUE(schedule_id, run_date), and runs of one user start under an advisory lock.
 */
import { dbPool } from '../db.js';
import { dailyLeadLimit, userMayUseLeadGen } from './access.js';
import { countLeadsFoundToday, listSources, MAX_CONCURRENT_RUNS, notifyUser, type Queryable } from './leadStore.js';
import { computeNextRunAt, DEFAULT_TIMEZONE, localDateOf } from './schedule.js';
import { pickDiscoverySources } from './sources/index.js';
import { enqueueTasks, PRIORITY } from './taskQueue.js';
import type { DiscoveryQuery, ScheduleFrequency } from './types.js';

/** After this many failed runs in a row the schedule pauses itself. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Advisory lock namespace for "start runs of one user". */
const USER_LOCK_NS = 74_201;

interface DueSchedule {
  id: number;
  saved_search_id: number;
  user_id: number;
  frequency: ScheduleFrequency;
  run_at_local: string;
  timezone: string;
  weekdays_mask: number;
  next_run_at: string;
}

/**
 * Creates the runs of all due schedules. A schedule that was due long ago (server was down) gets ONE run,
 * and its next run is the next slot after now: no backlog.
 */
export async function tickScheduler(now: Date = new Date(), random: () => number = Math.random): Promise<{ created: number; skipped: number }> {
  const client = await dbPool.connect();
  let created = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    const due = await client.query<DueSchedule>(
      `SELECT sch.id, sch.saved_search_id, ss.user_id, sch.frequency, sch.run_at_local::text AS run_at_local,
              sch.timezone, sch.weekdays_mask, sch.next_run_at
         FROM search_schedules sch
         JOIN saved_searches ss ON ss.id = sch.saved_search_id
        WHERE NOT sch.is_paused AND ss.is_active AND sch.next_run_at <= $1
        ORDER BY sch.next_run_at
        LIMIT 100
        FOR UPDATE OF sch SKIP LOCKED`,
      [now.toISOString()]
    );
    for (const s of due.rows) {
      const tz = s.timezone || DEFAULT_TIMEZONE;
      const timing = { frequency: s.frequency, runAtLocal: s.run_at_local, timezone: tz, weekdaysMask: s.weekdays_mask };
      const next = computeNextRunAt(timing, now, random);
      let made = false;
      if (await userMayUseLeadGen(s.user_id, client)) {
        const ins = await client.query(
          `INSERT INTO scrape_runs (user_id, saved_search_id, schedule_id, run_date, run_type, status)
           VALUES ($1, $2, $3, $4, 'search', 'queued')
           ON CONFLICT (schedule_id, run_date) WHERE schedule_id IS NOT NULL DO NOTHING`,
          [s.user_id, s.saved_search_id, s.id, localDateOf(new Date(s.next_run_at), tz)]
        );
        made = (ins.rowCount ?? 0) > 0;
      }
      await client.query(
        `UPDATE search_schedules SET next_run_at = $2, last_run_at = CASE WHEN $3 THEN $4::timestamptz ELSE last_run_at END WHERE id = $1`,
        [s.id, next.toISOString(), made, now.toISOString()]
      );
      if (made) created++;
      else skipped++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { created, skipped };
}

interface QueuedRun {
  id: number;
  user_id: number;
  saved_search_id: number | null;
  run_type: string;
}

interface SearchRow {
  name: string;
  category: string | null;
  keywords: string[];
  city: string | null;
  region: string | null;
  country_code: string | null;
  target_per_run: number;
  include_people: boolean;
  timezone: string | null;
}

async function finishWithoutTasks(q: Queryable, runId: number, status: 'partial' | 'failed', error: string): Promise<void> {
  await q.query(
    `UPDATE scrape_runs SET status = $2, error = $3, started_at = COALESCE(started_at, now()), completed_at = now() WHERE id = $1`,
    [runId, status, error]
  );
}

/** Starts queued user runs while the user has fewer than MAX_CONCURRENT_RUNS running. Returns how many started. */
export async function startQueuedRuns(limit = 20): Promise<number> {
  const candidates = await dbPool.query<{ id: number }>(
    `SELECT id FROM scrape_runs WHERE status = 'queued' AND user_id IS NOT NULL ORDER BY created_at, id LIMIT $1`,
    [limit]
  );
  let started = 0;
  for (const { id } of candidates.rows) {
    if (await startRun(id)) started++;
  }
  return started;
}

/** Starts one queued run if its user has room. Returns true when the run is now running. */
export async function startRun(runId: number): Promise<boolean> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const pick = await client.query<QueuedRun>(
      `SELECT id, user_id, saved_search_id, run_type FROM scrape_runs WHERE id = $1 AND status = 'queued' FOR UPDATE SKIP LOCKED`,
      [runId]
    );
    const run = pick.rows[0];
    if (!run) {
      await client.query('ROLLBACK');
      return false;
    }
    // Serialize starts per user so two workers cannot both see "1 running" and start a 3rd run.
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [USER_LOCK_NS, run.user_id]);
    const running = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scrape_runs WHERE user_id = $1 AND status = 'running'`,
      [run.user_id]
    );
    if ((running.rows[0]?.n ?? 0) >= MAX_CONCURRENT_RUNS) {
      await client.query('ROLLBACK');
      return false;
    }

    if (!(await userMayUseLeadGen(run.user_id, client))) {
      await finishWithoutTasks(client, run.id, 'failed', 'Lead Finder is not included in your plan.');
      await client.query('COMMIT');
      return false;
    }
    const search = (await client.query<SearchRow>(
      `SELECT ss.name, ss.category, ss.keywords, ss.city, ss.region, ss.country_code, ss.target_per_run, ss.include_people, sch.timezone
         FROM saved_searches ss LEFT JOIN search_schedules sch ON sch.saved_search_id = ss.id
        WHERE ss.id = $1 AND ss.user_id = $2`,
      [run.saved_search_id, run.user_id]
    )).rows[0];
    if (!search) {
      await finishWithoutTasks(client, run.id, 'failed', 'The saved search was deleted.');
      await client.query('COMMIT');
      return false;
    }
    const tz = search.timezone ?? DEFAULT_TIMEZONE;
    const limit = await dailyLeadLimit(run.user_id);
    if ((await countLeadsFoundToday(run.user_id, tz, client)) >= limit) {
      await finishWithoutTasks(client, run.id, 'partial', `Today's limit of ${limit} new leads is reached. The next run continues tomorrow.`);
      await client.query('COMMIT');
      return false;
    }
    const sources = pickDiscoverySources(await listSources(client));
    if (sources.length === 0) {
      await finishWithoutTasks(client, run.id, 'failed', 'No data source is available right now.');
      await client.query('COMMIT');
      return false;
    }

    const query: DiscoveryQuery = {
      category: search.category,
      keywords: search.keywords ?? [],
      city: search.city,
      region: search.region,
      countryCode: search.country_code,
      // Ask each source for more than needed: duplicates and known leads are dropped later.
      limit: Math.min(200, search.target_per_run * 3),
    };
    await client.query(`UPDATE scrape_runs SET status = 'running', started_at = now(), heartbeat_at = now() WHERE id = $1`, [run.id]);
    await enqueueTasks(
      run.id,
      sources.map((s) => ({
        taskType: 'discover' as const,
        target: `${s.code}:search:${run.saved_search_id}`,
        sourceId: s.id,
        payload: { query, targetPerRun: search.target_per_run, includePeople: search.include_people, timezone: tz },
        priority: run.run_type === 'refresh' ? PRIORITY.refresh : PRIORITY.user,
      })),
      client
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Tasks of a source that is cooling down (blocked) or switched off are skipped, so their run can finish
 * 'partial' instead of holding one of the user's run slots (UC-03, UC-05: "search source block: kal dobara").
 */
async function skipTasksOfSourcesOffForToday(q: Queryable): Promise<number> {
  const r = await q.query(
    `UPDATE scrape_tasks SET status = 'skipped', completed_at = now(), last_error = 'Source blocked or switched off'
      WHERE status = 'pending'
        AND source_id IN (SELECT id FROM sources WHERE cooldown_until > now() OR NOT is_enabled)`
  );
  return r.rowCount ?? 0;
}

interface FinishedRun {
  id: number;
  user_id: number | null;
  schedule_id: number | null;
  saved_search_id: number | null;
  search_name: string | null;
  done: number;
  failed: number;
  skipped: number;
  new_leads: number;
  quota_hit: boolean;
}

/**
 * Closes running runs that have no pending/running task left. Status: done (all tasks done),
 * partial (some failed/skipped), failed (none done). Updates the schedule's failure count and
 * pauses it after MAX_CONSECUTIVE_FAILURES failed runs. Returns how many runs were closed.
 */
export async function finalizeRuns(limit = 50): Promise<number> {
  await skipTasksOfSourcesOffForToday(dbPool);
  const client = await dbPool.connect();
  let closed = 0;
  try {
    await client.query('BEGIN');
    // Lock first (FOR UPDATE cannot be combined with GROUP BY), then count the tasks of the locked runs.
    const locked = await client.query<{ id: number }>(
      `SELECT r.id FROM scrape_runs r
        WHERE r.status = 'running'
          AND NOT EXISTS (SELECT 1 FROM scrape_tasks o WHERE o.run_id = r.id AND o.status IN ('pending', 'running'))
        ORDER BY r.id
        LIMIT $1
        FOR UPDATE OF r SKIP LOCKED`,
      [limit]
    );
    const runs = await client.query<FinishedRun>(
      `SELECT r.id, r.user_id, r.schedule_id, r.saved_search_id, ss.name AS search_name,
              count(t.id) FILTER (WHERE t.status = 'done')::int AS done,
              count(t.id) FILTER (WHERE t.status = 'failed')::int AS failed,
              count(t.id) FILTER (WHERE t.status = 'skipped')::int AS skipped,
              COALESCE((r.stats->>'new_leads')::int, 0) AS new_leads,
              COALESCE((r.stats->>'quota_hit')::int, 0) > 0 AS quota_hit
         FROM scrape_runs r
         LEFT JOIN saved_searches ss ON ss.id = r.saved_search_id
         LEFT JOIN scrape_tasks t ON t.run_id = r.id
        WHERE r.id = ANY($1::int[])
        GROUP BY r.id, ss.name`,
      [locked.rows.map((r) => r.id)]
    );
    for (const run of runs.rows) {
      const status = run.done === 0 ? 'failed' : run.failed + run.skipped > 0 || run.quota_hit ? 'partial' : 'done';
      const error =
        status === 'failed' ? 'No data could be collected. The sources may be blocked; the next run tries again.'
        : run.quota_hit ? "Today's new-lead limit was reached; the next run continues."
        : status === 'partial' ? 'Some sources could not be reached; results may be incomplete.'
        : null;
      await client.query(
        `UPDATE scrape_runs SET status = $2, completed_at = now(), error = $3,
                stats = stats || jsonb_build_object('failed', $4::int)
          WHERE id = $1`,
        [run.id, status, error, run.failed + run.skipped]
      );
      if (run.schedule_id) {
        const sch = await client.query<{ consecutive_failures: number; is_paused: boolean }>(
          `UPDATE search_schedules
              SET consecutive_failures = CASE WHEN $2 THEN consecutive_failures + 1 ELSE 0 END,
                  is_paused = is_paused OR ($2 AND consecutive_failures + 1 >= $3)
            WHERE id = $1
            RETURNING consecutive_failures, is_paused`,
          [run.schedule_id, status === 'failed', MAX_CONSECUTIVE_FAILURES]
        );
        const s = sch.rows[0];
        if (run.user_id && status === 'failed' && s && s.is_paused && s.consecutive_failures === MAX_CONSECUTIVE_FAILURES) {
          await notifyUser(run.user_id, 'leadgen_schedule_paused', {
            scheduleId: run.schedule_id, savedSearchId: run.saved_search_id, name: run.search_name,
            message: `"${run.search_name ?? 'Lead search'}" failed ${MAX_CONSECUTIVE_FAILURES} times in a row and was paused.`,
          }, client);
        }
      }
      if (run.user_id && status !== 'failed') {
        await notifyUser(run.user_id, 'leadgen_run_done', {
          runId: run.id, savedSearchId: run.saved_search_id, name: run.search_name, newLeads: run.new_leads, status,
          message: `${run.search_name ?? 'Lead search'}: ${run.new_leads} new lead${run.new_leads === 1 ? '' : 's'} today`,
        }, client);
      }
      closed++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return closed;
}
