/**
 * CRM worker (step 3). Started by `npm run dev` together with the API and the email worker,
 * or alone with `npm run worker:crm`.
 *
 *  - every minute: sends follow-ups planned by the schedule_follow_up rule action.
 *  - every 30 minutes (CRM_TICK_MINUTES): adds default rules to new pipelines, then fires a
 *    `time_tick` event for every lead in a pipeline that has active time_tick rules
 *    (e.g. "3 follow-ups, no reply, 5 days -> Lost"). Leads in Won/Lost stages are skipped.
 *  - every 15 minutes (CRM_REMINDER_MINUTES, step 6): bell reminders for leads waiting for your
 *    reply, and the optional daily digest email (from CRM_DIGEST_HOUR, server time, default 8).
 *  - with the time rules (step 7): recalculates lead scores older than 12 hours (up to 2000 per run),
 *    so "no activity for 14 days" lowers scores even when nothing happens.
 */
import 'dotenv/config';
import { dbPool } from '../lib/db.js';
import { emitCrmEvent } from '../lib/crm/events.js';
import { processDueFollowUps } from '../lib/crm/followUps.js';
import { seedDefaultRulesForAllPipelines } from '../lib/crm/pipelines.js';
import { processNeedsReplyReminders, sendNeedsReplyDigests } from '../lib/crm/needsReply.js';
import { getUserPlan } from '../lib/subscriptionService.js';
import { sendEmail } from '../lib/smtp.js';
import { recalcStaleScores } from '../lib/crm/leadScoring.js';

const LOOP_MS = 60_000;
const TICK_MINUTES = Math.max(1, Number(process.env.CRM_TICK_MINUTES) || 30);
const TICK_BATCH = 500;

let lastTick = 0;

const REMINDER_MINUTES = Math.max(1, Number(process.env.CRM_REMINDER_MINUTES) || 15);
const DIGEST_HOUR = Math.min(23, Math.max(0, Number(process.env.CRM_DIGEST_HOUR ?? 8) || 0));
let lastReminder = 0;

/** Admins and legacy users (no subscription) always have CRM; others need plans.crm_enabled. */
async function crmAllowed(userId: number): Promise<boolean> {
  const role = await dbPool.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [userId]);
  if (role.rows[0]?.role === 'admin' || role.rows[0]?.role === 'super_admin') return true;
  const plan = await getUserPlan(userId);
  return plan.crmEnabled !== false;
}

/** Step 6: bell reminders + daily digest. Exported for tests. */
export async function runRemindersOnce(): Promise<{ created: number; skipped: number; digests: { sent: number; empty: number; failed: number } }> {
  let created = 0;
  let skipped = 0;
  for (;;) {
    const r = await processNeedsReplyReminders(crmAllowed, 200);
    created += r.created;
    skipped += r.skipped;
    if (r.created + r.skipped < 200) break;
  }
  const digests = await sendNeedsReplyDigests({
    digestHour: DIGEST_HOUR,
    appUrl: process.env.APP_URL || process.env.FRONTEND_URL || null,
    planAllows: crmAllowed,
    send: ({ userId, to, subject, html, text }) => sendEmail({ userId, to, subject, html, text, fromName: 'MailFlow CRM' }),
  });
  return { created, skipped, digests };
}

export async function runTimeTickOnce(): Promise<{ contacts: number }> {
  const seeded = await seedDefaultRulesForAllPipelines();
  if (seeded > 0) console.log(`[CRM Worker] added ${seeded} default rule(s) to new pipelines`);

  let contacts = 0;
  let lastId = 0;
  for (;;) {
    const batch = await dbPool.query<{ id: number; user_id: number }>(
      `SELECT cc.id, cc.user_id
         FROM crm_contacts cc
         JOIN crm_pipeline_stages s ON s.id = cc.stage_id
        WHERE cc.id > $1
          AND s.type = 'normal'
          AND EXISTS (
            SELECT 1 FROM crm_rules r
             WHERE r.pipeline_id = cc.pipeline_id AND r.is_active AND r.trigger = 'time_tick'
               AND (r.from_stage_id IS NULL OR r.from_stage_id = cc.stage_id))
        ORDER BY cc.id
        LIMIT $2`,
      [lastId, TICK_BATCH]
    );
    if (batch.rows.length === 0) break;
    for (const c of batch.rows) {
      lastId = c.id;
      await emitCrmEvent(c.user_id, c.id, { type: 'time_tick' });
      contacts++;
    }
  }
  return { contacts };
}

async function loopOnce() {
  try {
    const fu = await processDueFollowUps();
    if (fu.sent + fu.cancelled + fu.failed + fu.retried > 0) {
      console.log(`[CRM Worker] scheduled follow-ups: ${fu.sent} sent, ${fu.cancelled} cancelled, ${fu.failed} failed, ${fu.retried} retry later`);
    }
  } catch (err) {
    console.error('[CRM Worker] scheduled follow-ups error:', err);
  }

  if (Date.now() - lastReminder >= REMINDER_MINUTES * 60_000) {
    lastReminder = Date.now();
    try {
      const r = await runRemindersOnce();
      if (r.created + r.digests.sent + r.digests.failed > 0) {
        console.log(`[CRM Worker] needs-reply: ${r.created} reminder(s), digest emails ${r.digests.sent} sent, ${r.digests.failed} failed`);
      }
    } catch (err) {
      console.error('[CRM Worker] needs-reply reminders error:', err);
    }
  }

  if (Date.now() - lastTick >= TICK_MINUTES * 60_000) {
    lastTick = Date.now();
    try {
      const t = await runTimeTickOnce();
      console.log(`[CRM Worker] time_tick checked ${t.contacts} lead(s)`);
    } catch (err) {
      console.error('[CRM Worker] time_tick error:', err);
    }
    try {
      const n = await recalcStaleScores({ staleHours: 12, limit: 2000 });
      if (n > 0) console.log(`[CRM Worker] recalculated ${n} lead score(s)`);
    } catch (err) {
      console.error('[CRM Worker] score recalculation error:', err);
    }
  }
}

async function run() {
  console.log(
    `[CRM Worker] started: follow-ups every ${LOOP_MS / 1000}s, time rules every ${TICK_MINUTES} min, needs-reply reminders every ${REMINDER_MINUTES} min (digest from ${DIGEST_HOUR}:00)`
  );
  for (;;) {
    await loopOnce();
    await new Promise((resolve) => setTimeout(resolve, LOOP_MS));
  }
}

// Only start the loop when this file is run directly (not when imported by tests/scripts).
const isMain = process.argv[1] ? /crmWorker\.(ts|js)$/.test(process.argv[1]) : false;
if (isMain) {
  run().catch((err) => {
    console.error('[CRM Worker] fatal error:', err);
    process.exit(1);
  });
}
