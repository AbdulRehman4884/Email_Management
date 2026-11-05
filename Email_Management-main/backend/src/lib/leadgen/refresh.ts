/**
 * Nightly refresh + data minimization (use case UC-09, section 8 "Refresh policy").
 *
 *   window      01:00-05:00 server time, one refresh run per night (system run: user_id null, priority 0,
 *               so user runs always go first)
 *   websites    every 30 days; hot leads of active users every 14 days (fetch_site; unchanged hash = no extraction)
 *   emails      MX again after 90 days (verify_email)
 *   people      every 60 days (find_social person: job change check)
 *   only        records in a workspace of an active user, or seen by a search in the last 90 days
 *   batch       at most REFRESH_BATCH companies a night
 *   purge       observations after 180 days; companies/people in no workspace and not seen for 365 days are deleted
 */
import { dbPool } from '../db.js';
import { getSourceByCode, purgeExpiredCache } from './leadStore.js';
import { enqueueTasks, PRIORITY, type NewTask } from './taskQueue.js';
import { localDateOf } from './schedule.js';

export const REFRESH_BATCH = Math.max(1, Number(process.env.LEADGEN_REFRESH_BATCH) || 500);
const REFRESH_LOCK = 74_204;

export function inRefreshWindow(now: Date, startHour = 1, endHour = 5): boolean {
  const h = now.getHours();
  return h >= startHour && h < endHour;
}

/**
 * Creates tonight's refresh run when it is time and none exists yet. Returns the run id, or null.
 * `force` skips the time window (tests, admin "refresh now").
 */
export async function startNightlyRefresh(now: Date = new Date(), opts: { force?: boolean; timezone?: string } = {}): Promise<number | null> {
  if (!opts.force && !inRefreshWindow(now)) return null;
  const runDate = localDateOf(now, opts.timezone ?? (process.env.DB_TIMEZONE || 'Asia/Karachi'));
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock($1, 0)`, [REFRESH_LOCK]);
    const exists = await client.query(`SELECT 1 FROM scrape_runs WHERE run_type = 'refresh' AND run_date = $1`, [runDate]);
    if (exists.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    const run = (await client.query<{ id: number }>(
      `INSERT INTO scrape_runs (user_id, run_date, run_type, status, started_at, heartbeat_at) VALUES (NULL, $1, 'refresh', 'running', now(), now()) RETURNING id`,
      [runDate]
    )).rows[0]!.id;

    const website = await getSourceByCode('website', client);
    const linkedin = await getSourceByCode('search_linkedin', client);
    const tasks: NewTask[] = [];

    // Companies due: 30 days, or 14 days for hot leads of active users. Only records someone still uses.
    const companies = await client.query<{ id: number; website_url: string }>(
      `SELECT c.id, c.website_url FROM companies c
        WHERE c.deleted_at IS NULL AND c.website_url IS NOT NULL
          AND (c.next_refresh_at <= now()
               OR (c.last_enriched_at < now() - interval '14 days' AND EXISTS (
                    SELECT 1 FROM workspace_leads w JOIN users u ON u.id = w.user_id AND u.is_active
                     WHERE w.company_id = c.id AND w.score_tier = 'hot' AND w.status <> 'rejected')))
          AND (EXISTS (SELECT 1 FROM workspace_leads w JOIN users u ON u.id = w.user_id AND u.is_active WHERE w.company_id = c.id AND w.status <> 'rejected')
               OR EXISTS (SELECT 1 FROM observations o WHERE o.entity_type = 'company' AND o.entity_id = c.id AND o.field = 'external_id' AND o.observed_at > now() - interval '90 days'))
        ORDER BY c.next_refresh_at NULLS FIRST
        LIMIT $1`,
      [REFRESH_BATCH]
    );
    if (website?.isEnabled) {
      for (const c of companies.rows) tasks.push({ taskType: 'fetch_site', target: c.website_url, sourceId: website.id, companyId: c.id, priority: PRIORITY.refresh });
    }

    // Emails: MX again after 90 days.
    const emails = await client.query<{ id: number }>(
      `SELECT cp.id FROM contact_points cp
        WHERE cp.type = 'email' AND (cp.last_verified_at IS NULL OR cp.last_verified_at < now() - interval '90 days')
          AND EXISTS (SELECT 1 FROM workspace_leads w LEFT JOIN people p ON p.id = cp.person_id
                       WHERE w.company_id = COALESCE(cp.company_id, p.current_company_id) AND w.status <> 'rejected')
        LIMIT $1`,
      [REFRESH_BATCH * 2]
    );
    for (const e of emails.rows) tasks.push({ taskType: 'verify_email', target: `contact:${e.id}`, sourceId: null, priority: PRIORITY.refresh });

    // People with a LinkedIn profile: job change check every 60 days.
    if (linkedin?.isEnabled) {
      const people = await client.query<{ id: number }>(
        `SELECT p.id FROM people p
          WHERE p.deleted_at IS NULL AND p.linkedin_url IS NOT NULL AND p.next_refresh_at <= now()
            AND EXISTS (SELECT 1 FROM workspace_leads w WHERE w.company_id = p.current_company_id AND w.status <> 'rejected')
          ORDER BY p.next_refresh_at LIMIT $1`,
        [Math.ceil(REFRESH_BATCH / 5)]
      );
      for (const p of people.rows) tasks.push({ taskType: 'find_social', target: `person:${p.id}`, sourceId: linkedin.id, priority: PRIORITY.refresh });
    }

    await enqueueTasks(run, tasks, client);
    if (tasks.length === 0) {
      await client.query(`UPDATE scrape_runs SET status = 'done', completed_at = now() WHERE id = $1`, [run]);
    }
    await client.query(`UPDATE scrape_runs SET stats = jsonb_build_object('refresh_tasks', $2::int) WHERE id = $1`, [run, tasks.length]);
    await client.query('COMMIT');
    return run;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface PurgeResult {
  observations: number;
  companies: number;
  people: number;
  cache: number;
  tasks: number;
}

/** Data minimization (section 8). Safe to run any time; the worker runs it once a day. */
export async function purgeOldData(): Promise<PurgeResult> {
  const observations = (await dbPool.query(
    `DELETE FROM observations WHERE observed_at < now() - interval '180 days' AND field <> 'external_id'`
  )).rowCount ?? 0;
  const people = (await dbPool.query(
    `DELETE FROM people p
      WHERE p.last_seen_at < now() - interval '365 days'
        AND NOT EXISTS (SELECT 1 FROM workspace_leads w WHERE w.person_id = p.id OR w.company_id = p.current_company_id)`
  )).rowCount ?? 0;
  const companies = (await dbPool.query(
    `DELETE FROM companies c
      WHERE COALESCE(c.last_enriched_at, c.first_seen_at) < now() - interval '365 days'
        AND NOT EXISTS (SELECT 1 FROM workspace_leads w WHERE w.company_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.entity_type = 'company' AND o.entity_id = c.id AND o.observed_at > now() - interval '365 days')`
  )).rowCount ?? 0;
  // Merged (soft-deleted) companies are kept for undo/audit for 90 days.
  await dbPool.query(`DELETE FROM companies WHERE deleted_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM workspace_leads w WHERE w.company_id = companies.id)`);
  // Finished task rows are only needed for the admin monitor.
  const tasks = (await dbPool.query(
    `DELETE FROM scrape_tasks WHERE status IN ('done', 'skipped', 'cancelled', 'failed') AND completed_at < now() - interval '30 days'`
  )).rowCount ?? 0;
  const cache = await purgeExpiredCache();
  return { observations, companies, people, cache, tasks };
}
