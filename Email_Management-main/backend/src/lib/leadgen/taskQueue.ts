/**
 * scrape_tasks queue in Postgres.
 *   - claim: FOR UPDATE SKIP LOCKED, so two workers never get the same task
 *   - lease token: `attempts` after the claim; finishing with an old token does nothing
 *     (the task was recovered and claimed again by someone else)
 *   - retry: 3 attempts, then failed. Backoff 1, 5, 30 minutes.
 *   - heartbeat: running tasks older than 5 minutes go back to the queue (worker crashed)
 *   - cancel: pending tasks of a cancelled run are cancelled; running ones finish but add no follow-ups
 */
import { dbPool } from '../db.js';
import type { Queryable } from './leadStore.js';
import type { RunStats, ScrapeTaskType } from './types.js';

export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
export const STALE_AFTER_MS = 5 * 60_000;

/** User runs come before the nightly refresh. */
export const PRIORITY = { user: 10, refresh: 0 } as const;

export interface NewTask {
  taskType: ScrapeTaskType;
  /** URL or query; unique per run and type. */
  target: string;
  sourceId: number | null;
  companyId?: number | null;
  payload?: Record<string, unknown>;
  priority?: number;
}

export interface ClaimedTask {
  id: number;
  runId: number;
  sourceId: number | null;
  sourceCode: string | null;
  taskType: ScrapeTaskType;
  target: string;
  companyId: number | null;
  payload: Record<string, unknown>;
  /** Lease token: pass it back to completeTask / failTask. */
  attempts: number;
  priority: number;
  userId: number | null;
  savedSearchId: number | null;
}

/** Adds tasks to a run. A task with the same (run, type, target) is not added twice. Returns how many were added. */
export async function enqueueTasks(runId: number, tasks: NewTask[], q: Queryable = dbPool): Promise<number> {
  if (tasks.length === 0) return 0;
  const r = await q.query(
    `INSERT INTO scrape_tasks (run_id, source_id, task_type, target, company_id, payload, priority)
     SELECT $1, t.source_id, t.task_type, left(t.target, 500), t.company_id, COALESCE(t.payload, '{}'::jsonb), COALESCE(t.priority, 0)
       FROM jsonb_to_recordset($2::jsonb) AS t(source_id int, task_type text, target text, company_id int, payload jsonb, priority int)
     ON CONFLICT (run_id, task_type, target) DO NOTHING`,
    [
      runId,
      JSON.stringify(tasks.map((t) => ({
        source_id: t.sourceId, task_type: t.taskType, target: t.target, company_id: t.companyId ?? null,
        payload: t.payload ?? {}, priority: t.priority ?? 0,
      }))),
    ]
  );
  return r.rowCount ?? 0;
}

/**
 * Claims up to `limit` due tasks of running runs. Tasks of a source on cooldown wait.
 * Highest priority first, then oldest.
 */
export async function claimTasks(limit: number, q: Queryable = dbPool): Promise<ClaimedTask[]> {
  if (limit <= 0) return [];
  const r = await q.query<ClaimedTask>(
    `WITH picked AS (
       SELECT t.id
         FROM scrape_tasks t
         JOIN scrape_runs r ON r.id = t.run_id
         LEFT JOIN sources s ON s.id = t.source_id
        WHERE t.status = 'pending'
          AND t.next_attempt_at <= now()
          AND r.status = 'running'
          AND (s.cooldown_until IS NULL OR s.cooldown_until <= now())
        ORDER BY t.priority DESC, t.next_attempt_at, t.id
        LIMIT $1
        FOR UPDATE OF t SKIP LOCKED
     )
     UPDATE scrape_tasks t
        SET status = 'running', attempts = t.attempts + 1, locked_at = now(), heartbeat_at = now()
       FROM picked, scrape_runs r
      WHERE t.id = picked.id AND r.id = t.run_id
     RETURNING t.id::int AS id, t.run_id AS "runId", t.source_id AS "sourceId",
               (SELECT code FROM sources WHERE id = t.source_id) AS "sourceCode",
               t.task_type AS "taskType", t.target, t.company_id AS "companyId", t.payload, t.attempts, t.priority,
               r.user_id AS "userId", r.saved_search_id AS "savedSearchId"`,
    [limit]
  );
  return r.rows;
}

/** Adds numbers to the run's stats ({discovered: 3} -> stats.discovered += 3) and touches its heartbeat. */
export async function addRunStats(runId: number, stats: RunStats, q: Queryable = dbPool): Promise<void> {
  const entries = Object.entries(stats).filter(([, v]) => typeof v === 'number' && v !== 0);
  if (entries.length === 0) {
    await q.query(`UPDATE scrape_runs SET heartbeat_at = now() WHERE id = $1`, [runId]);
    return;
  }
  await q.query(
    `UPDATE scrape_runs r
        SET heartbeat_at = now(),
            stats = r.stats || (SELECT jsonb_object_agg(k, COALESCE((r.stats->>k)::int, 0) + v::int)
                                  FROM jsonb_each_text($2::jsonb) AS e(k, v))
      WHERE r.id = $1`,
    [runId, JSON.stringify(Object.fromEntries(entries))]
  );
}

export interface TaskOutcome {
  followUps?: NewTask[];
  stats?: RunStats;
  /** Saved into scrape_tasks.payload.result (small summaries only, never raw HTML). */
  result?: unknown;
}

/**
 * Marks the task done, adds its follow-up tasks (only while the run is still running) and its stats.
 * Returns false when the lease was lost (recovered and claimed again): nothing is written then.
 */
export async function completeTask(task: Pick<ClaimedTask, 'id' | 'runId' | 'attempts'>, outcome: TaskOutcome = {}): Promise<boolean> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const done = await client.query(
      `UPDATE scrape_tasks SET status = 'done', completed_at = now(), locked_at = NULL, last_error = NULL,
              payload = CASE WHEN $3::jsonb IS NULL THEN payload ELSE payload || jsonb_build_object('result', $3::jsonb) END
        WHERE id = $1 AND status = 'running' AND attempts = $2`,
      [task.id, task.attempts, outcome.result === undefined ? null : JSON.stringify(outcome.result)]
    );
    if ((done.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const run = await client.query<{ status: string }>(`SELECT status FROM scrape_runs WHERE id = $1`, [task.runId]);
    if (run.rows[0]?.status === 'running' && outcome.followUps?.length) await enqueueTasks(task.runId, outcome.followUps, client);
    await addRunStats(task.runId, outcome.stats ?? {}, client);
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
 * A failed attempt. Retryable errors go back to the queue with backoff until MAX_ATTEMPTS;
 * otherwise the task is 'failed' ('skipped' with `skip`, e.g. a blocked source or robots.txt).
 * `retryAt` overrides the backoff (source cooldown end). Returns false when the lease was lost.
 */
export async function failTask(
  task: Pick<ClaimedTask, 'id' | 'attempts'>,
  error: string,
  opts: { retryable: boolean; skip?: boolean; retryAt?: Date | null } = { retryable: true },
  q: Queryable = dbPool
): Promise<'retry' | 'failed' | 'skipped' | false> {
  const retry = opts.retryable && !opts.skip && task.attempts < MAX_ATTEMPTS;
  const status = retry ? 'pending' : opts.skip ? 'skipped' : 'failed';
  const delay = BACKOFF_MS[Math.min(task.attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0];
  const nextAt = opts.retryAt ?? new Date(Date.now() + delay);
  const r = await q.query(
    `UPDATE scrape_tasks
        SET status = $3::varchar, last_error = left($4, 500), locked_at = NULL,
            next_attempt_at = CASE WHEN $3::varchar = 'pending' THEN $5::timestamptz ELSE next_attempt_at END,
            completed_at = CASE WHEN $3::varchar = 'pending' THEN NULL ELSE now() END
      WHERE id = $1 AND status = 'running' AND attempts = $2`,
    [task.id, task.attempts, status, error, nextAt.toISOString()]
  );
  if ((r.rowCount ?? 0) === 0) return false;
  return retry ? 'retry' : (status as 'failed' | 'skipped');
}

/** Keeps the lease of tasks this worker is still working on (and their runs) alive. */
export async function heartbeatTasks(taskIds: number[], q: Queryable = dbPool): Promise<void> {
  if (taskIds.length === 0) return;
  await q.query(
    `WITH t AS (UPDATE scrape_tasks SET heartbeat_at = now() WHERE id = ANY($1::bigint[]) AND status = 'running' RETURNING run_id)
     UPDATE scrape_runs SET heartbeat_at = now() WHERE id IN (SELECT run_id FROM t)`,
    [taskIds]
  );
}

/**
 * Tasks whose worker stopped sending heartbeats go back to the queue (or fail after MAX_ATTEMPTS).
 * Returns how many were recovered.
 */
export async function recoverStaleTasks(staleAfterMs = STALE_AFTER_MS, q: Queryable = dbPool): Promise<number> {
  const r = await q.query(
    `UPDATE scrape_tasks
        SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
            locked_at = NULL, next_attempt_at = now(), last_error = 'Worker stopped while working on this task',
            completed_at = CASE WHEN attempts >= $2 THEN now() ELSE NULL END
      WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' milliseconds')::interval`,
    [String(staleAfterMs), MAX_ATTEMPTS]
  );
  return r.rowCount ?? 0;
}

/** Puts tasks back without counting the attempt (graceful shutdown). */
export async function releaseTasks(tasks: Array<Pick<ClaimedTask, 'id' | 'attempts'>>, q: Queryable = dbPool): Promise<void> {
  for (const t of tasks) {
    await q.query(
      `UPDATE scrape_tasks SET status = 'pending', attempts = attempts - 1, locked_at = NULL, next_attempt_at = now()
        WHERE id = $1 AND status = 'running' AND attempts = $2`,
      [t.id, t.attempts]
    );
  }
}

/**
 * Cancels a queued or running run (only the user's own run when userId is given).
 * Returns false if there was nothing to cancel.
 */
export async function cancelRun(runId: number, userId: number | null = null, q: Queryable = dbPool): Promise<boolean> {
  const r = await q.query(
    `UPDATE scrape_runs SET status = 'cancelled', completed_at = now()
      WHERE id = $1 AND status IN ('queued', 'running') AND ($2::int IS NULL OR user_id = $2)`,
    [runId, userId]
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await q.query(
    `UPDATE scrape_tasks SET status = 'cancelled', completed_at = now() WHERE run_id = $1 AND status = 'pending'`,
    [runId]
  );
  return true;
}
