/**
 * Run: LEADGEN_TEST_DATABASE_URL=postgres://.../leadgen_test npm run test:leadgen:db
 *
 * Needs a THROWAWAY database with the app schema + migration 0037 (it truncates the lead engine tables).
 * Skipped when LEADGEN_TEST_DATABASE_URL is not set. Never point it at a real database.
 *
 * Lead Engine Day 1, pipeline: two schedulers / two workers never duplicate work, a killed worker's
 * task comes back, retries + backoff, cancel, max 2 runs per user, quota, auto-pause, source cooldown.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DB = process.env.LEADGEN_TEST_DATABASE_URL;
const skip = !TEST_DB ? 'set LEADGEN_TEST_DATABASE_URL to a throwaway database' : false;
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.LEADGEN_ENABLED = 'admin';
  delete process.env.LEADGEN_SERP_API_KEY;
}

// Imported after DATABASE_URL is set (db.ts reads it at import time).
type Mods = {
  db: typeof import('../db.js');
  queue: typeof import('../leadgen/taskQueue.js');
  sched: typeof import('../leadgen/scheduler.js');
  store: typeof import('../leadgen/leadStore.js');
};
let m: Mods;
let userId = 0;
let otherUserId = 0;
let runDay = 0;

const q = (sql: string, params: unknown[] = []) => m.db.dbPool.query(sql, params);

async function makeSearch(owner = userId, name = 'Lahore dentists'): Promise<number> {
  const r = await q(
    `INSERT INTO saved_searches (user_id, name, category, city, country_code, target_per_run) VALUES ($1, $2, 'dentist', 'Lahore', 'PK', 20) RETURNING id`,
    [owner, name]
  );
  return r.rows[0].id;
}

async function makeSchedule(searchId: number, nextRunAt: Date): Promise<number> {
  const r = await q(
    `INSERT INTO search_schedules (saved_search_id, run_at_local, timezone, next_run_at) VALUES ($1, '09:00', 'Asia/Karachi', $2) RETURNING id`,
    [searchId, nextRunAt.toISOString()]
  );
  return r.rows[0].id;
}

async function makeRun(searchId: number, status = 'running', scheduleId: number | null = null, owner = userId): Promise<number> {
  const r = await q(
    `INSERT INTO scrape_runs (user_id, saved_search_id, schedule_id, run_date, run_type, status, started_at)
     VALUES ($1, $2, $3, current_date - $5::int, 'search', $4, now()) RETURNING id`,
    [owner, searchId, scheduleId, status, ++runDay]
  );
  return r.rows[0].id;
}

async function sourceId(code: string): Promise<number> {
  return (await q(`SELECT id FROM sources WHERE code = $1`, [code])).rows[0].id;
}

before(async () => {
  if (skip) return;
  m = {
    db: await import('../db.js'),
    queue: await import('../leadgen/taskQueue.js'),
    sched: await import('../leadgen/scheduler.js'),
    store: await import('../leadgen/leadStore.js'),
  };
  const stamp = Date.now();
  userId = (await q(`INSERT INTO users (email, password_hash, name, role) VALUES ($1, 'x', 'LeadGen Test', 'admin') RETURNING id`, [`leadgen-${stamp}@test.local`])).rows[0].id;
  otherUserId = (await q(`INSERT INTO users (email, password_hash, name, role) VALUES ($1, 'x', 'LeadGen Other', 'admin') RETURNING id`, [`leadgen-o-${stamp}@test.local`])).rows[0].id;
});

beforeEach(async () => {
  if (skip) return;
  await q(`TRUNCATE scrape_tasks, scrape_runs, search_schedules, saved_searches, workspace_leads, companies, source_daily_usage, leadgen_cache, do_not_collect CASCADE`);
  await q(`UPDATE sources SET cooldown_until = NULL, is_enabled = (code <> 'serp_api')`);
  await q(`DELETE FROM user_notifications WHERE user_id IN ($1, $2)`, [userId, otherUserId]);
});

after(async () => {
  if (skip) return;
  await q(`TRUNCATE scrape_tasks, scrape_runs, search_schedules, saved_searches, workspace_leads, companies CASCADE`);
  await q(`DELETE FROM user_notifications WHERE user_id IN ($1, $2)`, [userId, otherUserId]);
  await q(`DELETE FROM users WHERE id IN ($1, $2)`, [userId, otherUserId]);
  await m.db.dbPool.end();
});

test('two schedulers at the same time create exactly one run per schedule per day', { skip }, async () => {
  const search = await makeSearch();
  const sch = await makeSchedule(search, new Date(Date.now() - 60_000));
  const now = new Date();
  const results = await Promise.all([m.sched.tickScheduler(now), m.sched.tickScheduler(now), m.sched.tickScheduler(now)]);
  assert.equal(results.reduce((n, r) => n + r.created, 0), 1);
  assert.equal((await q(`SELECT count(*)::int AS n FROM scrape_runs WHERE schedule_id = $1`, [sch])).rows[0].n, 1);
  const next = (await q(`SELECT next_run_at FROM search_schedules WHERE id = $1`, [sch])).rows[0].next_run_at;
  assert.ok(new Date(next).getTime() > now.getTime(), 'next run moved to the future');

  // Same slot date again (e.g. the time was edited back): still one run for that day.
  await q(`UPDATE search_schedules SET next_run_at = (SELECT (run_date::timestamp + time '12:00') AT TIME ZONE 'Asia/Karachi' FROM scrape_runs WHERE schedule_id = $1) WHERE id = $1`, [sch]);
  await m.sched.tickScheduler(new Date());
  assert.equal((await q(`SELECT count(*)::int AS n FROM scrape_runs WHERE schedule_id = $1`, [sch])).rows[0].n, 1);
});

test('server down for 3 days: one run, then the next slot after now (no backlog)', { skip }, async () => {
  const sch = await makeSchedule(await makeSearch(), new Date(Date.now() - 3 * 86_400_000));
  const now = new Date();
  assert.equal((await m.sched.tickScheduler(now)).created, 1);
  assert.equal((await m.sched.tickScheduler(now)).created, 0);
  const next = new Date((await q(`SELECT next_run_at FROM search_schedules WHERE id = $1`, [sch])).rows[0].next_run_at);
  assert.ok(next > now && next.getTime() - now.getTime() <= 86_400_000 + 11 * 60_000);
});

test('paused schedules and inactive searches do not run', { skip }, async () => {
  const a = await makeSchedule(await makeSearch(), new Date(Date.now() - 60_000));
  await q(`UPDATE search_schedules SET is_paused = true WHERE id = $1`, [a]);
  const s2 = await makeSearch(userId, 'inactive');
  await makeSchedule(s2, new Date(Date.now() - 60_000));
  await q(`UPDATE saved_searches SET is_active = false WHERE id = $1`, [s2]);
  assert.equal((await m.sched.tickScheduler()).created, 0);
});

test('two workers claiming at the same time never get the same task', { skip }, async () => {
  const run = await makeRun(await makeSearch());
  const osm = await sourceId('osm');
  await m.queue.enqueueTasks(run, Array.from({ length: 60 }, (_, i) => ({ taskType: 'discover' as const, target: `t${i}`, sourceId: osm })));
  const worker = async () => {
    const got: number[] = [];
    for (;;) {
      const batch = await m.queue.claimTasks(3);
      if (batch.length === 0) return got;
      got.push(...batch.map((t) => t.id));
    }
  };
  const [a, b, c] = await Promise.all([worker(), worker(), worker()]);
  const all = [...a!, ...b!, ...c!];
  assert.equal(all.length, 60);
  assert.equal(new Set(all).size, 60, 'no task claimed twice');
});

test('killed worker: its task returns to the queue and its late result is dropped', { skip }, async () => {
  const run = await makeRun(await makeSearch());
  await m.queue.enqueueTasks(run, [{ taskType: 'discover', target: 'x', sourceId: await sourceId('osm') }]);
  const [first] = await m.queue.claimTasks(1);
  assert.ok(first);
  await q(`UPDATE scrape_tasks SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [first.id]);
  assert.equal(await m.queue.recoverStaleTasks(), 1);
  const [second] = await m.queue.claimTasks(1);
  assert.equal(second?.id, first.id);
  assert.equal(second?.attempts, 2);
  assert.equal(await m.queue.completeTask(first, { stats: { discovered: 99 } }), false, 'old lease cannot finish');
  assert.equal(await m.queue.completeTask(second!, { stats: { discovered: 5 } }), true);
  const r = (await q(`SELECT r.stats FROM scrape_runs r JOIN scrape_tasks t ON t.run_id = r.id WHERE t.id = $1`, [first.id])).rows[0];
  assert.equal(r.stats.discovered, 5);
});

test('heartbeat keeps a long task from being recovered', { skip }, async () => {
  const run = await makeRun(await makeSearch());
  await m.queue.enqueueTasks(run, [{ taskType: 'discover', target: 'long', sourceId: null }]);
  const [t] = await m.queue.claimTasks(1);
  await q(`UPDATE scrape_tasks SET heartbeat_at = now() - interval '4 minutes' WHERE id = $1`, [t!.id]);
  await m.queue.heartbeatTasks([t!.id]);
  assert.equal(await m.queue.recoverStaleTasks(), 0);
});

test('3 attempts with 1 and 5 minute backoff, then failed', { skip }, async () => {
  const run = await makeRun(await makeSearch());
  await m.queue.enqueueTasks(run, [{ taskType: 'discover', target: 'flaky', sourceId: null }]);
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    await q(`UPDATE scrape_tasks SET next_attempt_at = now() WHERE run_id = $1`, [run]);
    const [t] = await m.queue.claimTasks(1);
    const res = await m.queue.failTask(t!, 'boom', { retryable: true });
    const row = (await q(`SELECT status, EXTRACT(EPOCH FROM next_attempt_at - now())::int AS wait FROM scrape_tasks WHERE id = $1`, [t!.id])).rows[0];
    if (i < 2) {
      assert.equal(res, 'retry');
      delays.push(row.wait);
    } else {
      assert.equal(res, 'failed');
      assert.equal(row.status, 'failed');
    }
  }
  assert.ok(delays[0]! >= 55 && delays[0]! <= 60, `first wait ${delays[0]}`);
  assert.ok(delays[1]! >= 295 && delays[1]! <= 300, `second wait ${delays[1]}`);
});

test('cancel: pending tasks are cancelled and nothing more is claimed; other users cannot cancel', { skip }, async () => {
  const run = await makeRun(await makeSearch());
  await m.queue.enqueueTasks(run, [1, 2, 3].map((i) => ({ taskType: 'discover' as const, target: `c${i}`, sourceId: null })));
  assert.equal(await m.queue.cancelRun(run, otherUserId), false);
  assert.equal(await m.queue.cancelRun(run, userId), true);
  assert.equal((await m.queue.claimTasks(5)).length, 0);
  assert.equal((await q(`SELECT count(*)::int AS n FROM scrape_tasks WHERE run_id = $1 AND status = 'cancelled'`, [run])).rows[0].n, 3);
});

test('a user never has more than 2 runs running; each started run gets a discover task per source', { skip }, async () => {
  const search = await makeSearch();
  const runs = [await makeRun(search, 'queued'), await makeRun(search, 'queued'), await makeRun(search, 'queued')];
  const started = await Promise.all([m.sched.startQueuedRuns(), m.sched.startQueuedRuns()]);
  assert.equal(started[0]! + started[1]!, 2);
  const states = (await q(`SELECT status, count(*)::int AS n FROM scrape_runs WHERE id = ANY($1) GROUP BY status`, [runs])).rows;
  assert.deepEqual(Object.fromEntries(states.map((r) => [r.status, r.n])), { running: 2, queued: 1 });
  const tasks = (await q(`SELECT s.code FROM scrape_tasks t JOIN sources s ON s.id = t.source_id WHERE t.run_id = ANY($1) ORDER BY s.code`, [runs])).rows;
  assert.deepEqual([...new Set(tasks.map((t) => t.code))], ['ddg', 'osm'], 'OSM + DuckDuckGo (no SERP key)');
  assert.equal(tasks.length, 4);
});

test('daily lead quota reached: the run ends partial without tasks', { skip }, async () => {
  const search = await makeSearch();
  await q(`INSERT INTO companies (name, normalized_name) SELECT 'C' || g, 'c' || g FROM generate_series(1, 50) g`);
  await q(`INSERT INTO workspace_leads (user_id, company_id, saved_search_id) SELECT $1, id, $2 FROM companies`, [userId, search]);
  const run = await makeRun(search, 'queued');
  assert.equal(await m.sched.startRun(run), false);
  const r = (await q(`SELECT status, error FROM scrape_runs WHERE id = $1`, [run])).rows[0];
  assert.equal(r.status, 'partial');
  assert.match(r.error, /limit of 50/);
});

test('finished runs close; 3 failed scheduled runs in a row pause the schedule with a bell', { skip }, async () => {
  const search = await makeSearch();
  const sch = await makeSchedule(search, new Date(Date.now() + 86_400_000));
  const ok = await makeRun(search, 'running', sch);
  await m.queue.enqueueTasks(ok, [{ taskType: 'discover', target: 'a', sourceId: null }]);
  const [t] = await m.queue.claimTasks(1);
  await m.queue.completeTask(t!, { stats: { new_leads: 4 } });
  assert.equal(await m.sched.finalizeRuns(), 1);
  assert.equal((await q(`SELECT status FROM scrape_runs WHERE id = $1`, [ok])).rows[0].status, 'done');

  for (let i = 0; i < 3; i++) {
    const bad = await makeRun(search, 'running', sch);
    await m.queue.enqueueTasks(bad, [{ taskType: 'discover', target: 'b', sourceId: null }]);
    const [bt] = await m.queue.claimTasks(1);
    await m.queue.failTask(bt!, 'down', { retryable: false });
    await m.sched.finalizeRuns();
    assert.equal((await q(`SELECT status FROM scrape_runs WHERE id = $1`, [bad])).rows[0].status, 'failed');
  }
  const s = (await q(`SELECT is_paused, consecutive_failures FROM search_schedules WHERE id = $1`, [sch])).rows[0];
  assert.deepEqual(s, { is_paused: true, consecutive_failures: 3 });
  const bells = (await q(`SELECT type FROM user_notifications WHERE user_id = $1 ORDER BY id`, [userId])).rows.map((r) => r.type);
  assert.deepEqual(bells, ['leadgen_run_done', 'leadgen_schedule_paused']);
});

test('a blocked source cools down: its tasks wait, other sources keep running', { skip }, async () => {
  const run = await makeRun(await makeSearch());
  const ddg = await sourceId('ddg');
  const osm = await sourceId('osm');
  await m.queue.enqueueTasks(run, [{ taskType: 'discover', target: 'd', sourceId: ddg }, { taskType: 'discover', target: 'o', sourceId: osm }]);
  const block = await m.store.recordSourceBlock(ddg);
  assert.equal(block.offForToday, false);
  assert.ok(new Date(block.cooldownUntil).getTime() > Date.now() + 55 * 60_000);
  const claimed = await m.queue.claimTasks(5);
  assert.deepEqual(claimed.map((c) => c.sourceCode), ['osm']);
  const usage = await m.store.getSourceUsageToday(ddg);
  assert.equal(usage.blockedCount, 1);
});

test('20 blocks in a day: source off until tomorrow and its waiting tasks are skipped', { skip }, async () => {
  const ddg = await sourceId('ddg');
  let last = { offForToday: false } as { offForToday: boolean };
  for (let i = 0; i < 20; i++) last = await m.store.recordSourceBlock(ddg);
  assert.equal(last.offForToday, true);
  const run = await makeRun(await makeSearch());
  await m.queue.enqueueTasks(run, [{ taskType: 'discover', target: 'd', sourceId: ddg }]);
  await m.sched.finalizeRuns();
  assert.equal((await q(`SELECT status FROM scrape_tasks WHERE run_id = $1`, [run])).rows[0].status, 'skipped');
  assert.equal((await q(`SELECT status FROM scrape_runs WHERE id = $1`, [run])).rows[0].status, 'failed');
});

test('do_not_collect: hashed identifiers block collection', { skip }, async () => {
  assert.equal(await m.store.isDoNotCollect([{ type: 'email', value: 'Ali@Acme.com' }]), false);
  await m.store.addDoNotCollect('email', 'ali@acme.com');
  assert.equal(await m.store.isDoNotCollect([{ type: 'domain', value: 'other.com' }, { type: 'email', value: ' ALI@acme.com ' }]), true);
  const raw = (await q(`SELECT identifier_hash FROM do_not_collect`)).rows[0].identifier_hash;
  assert.doesNotMatch(raw, /acme/, 'only the hash is stored');
});

test('cache: set, get, expiry', { skip }, async () => {
  await m.store.cacheSet('k1', { a: 1 }, 60_000);
  assert.deepEqual(await m.store.cacheGet('k1'), { a: 1 });
  await m.store.cacheSet('k2', [1], 0);
  assert.equal(await m.store.cacheGet('k2'), null);
  assert.equal(await m.store.purgeExpiredCache(), 1);
  assert.ok(m.store.cacheKey('x'.repeat(400)).length <= 300);
});
