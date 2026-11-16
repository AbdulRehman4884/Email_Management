/**
 * Lead Engine worker. Start with `npm run worker:leadgen`; run as many processes as needed
 * (tasks are claimed with FOR UPDATE SKIP LOCKED, so two processes never work on the same task).
 *
 *  - every 5 s: claims due tasks (up to LEADGEN_WORKER_CONCURRENCY at once, default 4) and runs them
 *  - every 30 s: heartbeat for the tasks in progress
 *  - every minute: due schedules -> runs, queued runs -> running, stale tasks back to the queue
 *    (worker crashed: heartbeat older than 5 minutes), finished runs closed
 *  - 01:00-05:00 server time: one nightly refresh run (websites 30/14 days, emails 90, people 60)
 *  - once a day: data minimization (observations 180 days, unused records 365 days, expired cache)
 *
 * Does nothing while LEADGEN_ENABLED is off. Ctrl+C / SIGTERM: stops claiming, waits up to 20 s,
 * then puts unfinished tasks back without counting the attempt.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { dbPool } from '../lib/db.js';
import { leadGenMode } from '../lib/leadgen/config.js';
import { purgeOldData, startNightlyRefresh } from '../lib/leadgen/refresh.js';
import { finalizeRuns, startQueuedRuns, tickScheduler } from '../lib/leadgen/scheduler.js';
import { claimTasks, completeTask, heartbeatTasks, recoverStaleTasks, releaseTasks, type ClaimedTask } from '../lib/leadgen/taskQueue.js';
import { HANDLERS, handleTaskError } from '../lib/leadgen/taskHandlers.js';

const WORKER_ID = `leadgen-${process.pid}-${randomUUID().slice(0, 8)}`;
const CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.LEADGEN_WORKER_CONCURRENCY) || 4));
const CLAIM_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const MAINTENANCE_MS = 60_000;
const SHUTDOWN_WAIT_MS = 20_000;

const inFlight = new Map<number, ClaimedTask>();
let stopping = false;
let lastMaintenance = 0;
let lastHeartbeat = 0;
let lastCachePurge = 0;

/** Runs one claimed task to its next state. Exported for tests. */
export async function processTask(task: ClaimedTask): Promise<void> {
  const handler = HANDLERS[task.taskType];
  try {
    if (!handler) throw new Error(`No handler for task type ${task.taskType}`);
    const outcome = await handler(task);
    const ok = await completeTask(task, outcome);
    if (!ok) console.warn(`[LeadGen Worker] task ${task.id}: lease lost, result dropped (another worker owns it now)`);
  } catch (err) {
    const next = await handleTaskError(task, err).catch((e) => {
      console.error(`[LeadGen Worker] task ${task.id}: could not record the error:`, e);
      return false as const;
    });
    console.warn(`[LeadGen Worker] task ${task.id} (${task.taskType} ${task.sourceCode ?? ''}) -> ${next || 'lease lost'}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Scheduler + recovery + run bookkeeping. Exported for tests. */
export async function maintenanceOnce(): Promise<{ runsCreated: number; runsStarted: number; recovered: number; runsClosed: number }> {
  const recovered = await recoverStaleTasks();
  const { created } = await tickScheduler();
  const refreshRun = await startNightlyRefresh();
  if (refreshRun) console.log(`[LeadGen Worker] nightly refresh run ${refreshRun} started`);
  const runsStarted = await startQueuedRuns();
  const runsClosed = await finalizeRuns();
  return { runsCreated: created, runsStarted, recovered, runsClosed };
}

async function fillSlots(): Promise<void> {
  const free = CONCURRENCY - inFlight.size;
  if (free <= 0 || stopping) return;
  const tasks = await claimTasks(free);
  for (const t of tasks) {
    inFlight.set(t.id, t);
    void processTask(t).finally(() => inFlight.delete(t.id));
  }
}

async function loopOnce(): Promise<void> {
  if (leadGenMode() === 'off') return;
  const now = Date.now();
  if (now - lastMaintenance >= MAINTENANCE_MS) {
    lastMaintenance = now;
    try {
      const m = await maintenanceOnce();
      if (m.runsCreated + m.runsStarted + m.recovered + m.runsClosed > 0) {
        console.log(`[LeadGen Worker] runs: ${m.runsCreated} created, ${m.runsStarted} started, ${m.runsClosed} closed; ${m.recovered} task(s) recovered`);
      }
    } catch (err) {
      console.error('[LeadGen Worker] maintenance error:', err);
    }
  }
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    await heartbeatTasks([...inFlight.keys()]).catch((err) => console.error('[LeadGen Worker] heartbeat error:', err));
  }
  if (now - lastCachePurge >= 86_400_000) {
    lastCachePurge = now;
    await purgeOldData()
      .then((p) => console.log(`[LeadGen Worker] purge: ${p.observations} observation(s), ${p.companies} company(ies), ${p.people} people, ${p.cache} cache row(s), ${p.tasks} old task(s)`))
      .catch((err) => console.error('[LeadGen Worker] purge error:', err));
  }
  try {
    await fillSlots();
  } catch (err) {
    console.error('[LeadGen Worker] claim error:', err);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[LeadGen Worker] ${signal}: finishing ${inFlight.size} task(s)...`);
  const until = Date.now() + SHUTDOWN_WAIT_MS;
  while (inFlight.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  if (inFlight.size > 0) {
    await releaseTasks([...inFlight.values()]).catch((err) => console.error('[LeadGen Worker] release error:', err));
    console.log(`[LeadGen Worker] put ${inFlight.size} unfinished task(s) back in the queue`);
  }
  await dbPool.end().catch(() => undefined);
  process.exit(0);
}

async function run(): Promise<void> {
  console.log(`[LeadGen Worker] ${WORKER_ID} started: ${CONCURRENCY} task(s) at once, mode ${leadGenMode()}${leadGenMode() === 'off' ? ' (idle until LEADGEN_ENABLED is set)' : ''}`);
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  while (!stopping) {
    await loopOnce();
    await new Promise((resolve) => setTimeout(resolve, CLAIM_MS));
  }
}

// Only start the loop when this file is run directly (not when imported by tests/scripts).
const isMain = process.argv[1] ? /leadGenWorker\.(ts|js)$/.test(process.argv[1]) : false;
if (isMain) {
  run().catch((err) => {
    console.error('[LeadGen Worker] fatal error:', err);
    process.exit(1);
  });
}
