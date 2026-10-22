/**
 * Small in-process queue for CRM background work (step 9).
 *
 * Sending, open tracking, webhooks and the IMAP poller hand CRM work (events, reply labeling) to this
 * queue and return at once. At most CRM_BACKGROUND_CONCURRENCY jobs (default 3) run at the same time,
 * so the CRM never takes more than a few of the database pool's connections (pg default: 10).
 * When the IMAP worker saves 500 replies in one poll, its own queries are not stuck behind 1000 CRM jobs.
 *
 * Jobs run in the order they were added. A failing job is logged and never stops the queue.
 * The queue lives in memory: work still waiting when the process stops is lost, the same as before
 * (the CRM worker's time rules, needs-reply check and score refresh catch up later).
 */
const CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.CRM_BACKGROUND_CONCURRENCY) || 3));
/** Above this many waiting jobs, a warning is logged (once per minute). Nothing is dropped. */
const WARN_QUEUE_LENGTH = 5000;

type Job = { name: string; run: () => Promise<unknown> };

const waiting: Job[] = [];
let head = 0;
let running = 0;
let lastWarn = 0;

function pump(): void {
  while (running < CONCURRENCY && head < waiting.length) {
    const job = waiting[head]!;
    waiting[head++] = undefined as unknown as Job; // free memory
    if (head > 1024 && head * 2 > waiting.length) {
      waiting.splice(0, head);
      head = 0;
    }
    running++;
    Promise.resolve()
      .then(job.run)
      .catch((err) => console.error(`[crm] background job "${job.name}" failed:`, err))
      .finally(() => {
        running--;
        pump();
      });
  }
}

/** Add a job. Returns at once; the job starts when a slot is free. Never throws. */
export function runCrmInBackground(name: string, run: () => Promise<unknown>): void {
  waiting.push({ name, run });
  const length = waiting.length - head;
  if (length > WARN_QUEUE_LENGTH && Date.now() - lastWarn > 60_000) {
    lastWarn = Date.now();
    console.warn(`[crm] ${length} CRM background jobs waiting (running ${running} at a time)`);
  }
  setImmediate(pump);
}

/** For tests and graceful shutdown: resolves when nothing is waiting or running. */
export async function crmBackgroundIdle(): Promise<void> {
  while (running > 0 || head < waiting.length) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function crmBackgroundStats(): { waiting: number; running: number; concurrency: number } {
  return { waiting: waiting.length - head, running, concurrency: CONCURRENCY };
}
