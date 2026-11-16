/**
 * Lead automations: runs the steps of an automation for one lead (see automationSteps.ts for the steps).
 *
 *  - startAutomationForForm(): a form submit puts the lead in the form's automation and runs the first
 *    steps at once (the welcome email goes out within seconds).
 *  - processDueAutomationRuns(): the CRM worker (every minute) continues leads whose wait is over.
 *  - applyCallResult(): the user picked the result of a call (Interested / No answer / Not interested).
 *  - stopRunByUser(): the user stopped one lead.
 *
 * A run stops by itself when the lead unsubscribed or bounced (suppression list) or is in a Won/Lost stage.
 * A reply does not stop it. While the automation is off, its leads wait and continue when it is on again.
 * Emails go through the automation's own email account and count against that account's daily limit
 * (campaign sends + automation sends of today).
 *
 * crm_automation_runs.status: active -> running -> active (waiting) | waiting_call | completed | stopped.
 * A worker "claims" a run by setting status = 'running'; every later save checks it is still running,
 * so a run stopped by the user meanwhile is never changed back.
 *
 * Nothing here runs before migration 0040 (automationTablesReady()).
 */
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';
import { sendEmail } from '../smtp.js';
import { getSmtpProfileRow } from '../smtpSettings.js';
import { countSendsTodayForSmtp, interpretSmtpDailyLimit } from '../dailySendQuota.js';
import { canAutoMove, type StageInfo } from './movePolicy.js';
import { cancelPendingFollowUps, isFollowUpBlockedForRecipient } from './followUps.js';
import { sendFollowUpOutbound } from '../sendFollowUp.js';
import {
  CALL_RESULT_LABELS,
  campaignStopRule,
  fillPlaceholders,
  kindOf,
  replySubject,
  stopRule,
  storedSteps,
  waitMs,
  type AutomationStep,
  type CallResult,
  type CallStep,
  type EmailStep,
  type LeadFields,
  type ResultStep,
} from './automationSteps.js';

type Db = Pick<PoolClient, 'query'>;

/** Steps one run may do in one go before it continues on the next worker round (loop safety). */
const MAX_STEPS_PER_ROUND = 30;
/** An email that fails this many times is skipped (the next step runs). */
const MAX_EMAIL_TRIES = 3;
const RETRY_FAILED_EMAIL_MIN = 30;
const RETRY_LIMIT_MIN = 60;
const OFF_RECHECK_MIN = 15;
/** A form submit does not restart an automation the lead finished less than this long ago. */
const RESTART_AFTER_HOURS = 24;
const OPEN_STATUSES = ['active', 'running', 'waiting_call'];

// ─── Migration check ────────────────────────────────────────────────────────

let tablesReady = false;
let tablesCheckedAt = 0;

/** True once migrations 0040 and 0041 are applied (checked at most once a minute until they are). */
export async function automationTablesReady(db: Db = dbPool): Promise<boolean> {
  if (tablesReady) return true;
  if (Date.now() - tablesCheckedAt < 60_000) return false;
  tablesCheckedAt = Date.now();
  const r = await db.query<{ ok: boolean }>(`SELECT to_regclass('crm_campaign_automations') IS NOT NULL AS ok`);
  tablesReady = r.rows[0]?.ok === true;
  return tablesReady;
}

/** Last result of automationTablesReady(), for code that cannot wait (SQL builders). */
export function automationTablesKnownReady(): boolean {
  return tablesReady;
}

// ─── Rows ───────────────────────────────────────────────────────────────────

export interface RunRow {
  id: number;
  automation_id: number;
  user_id: number;
  /** Null for campaign runs. */
  contact_id: number | null;
  form_id: number | null;
  /** Campaign runs (migration 0041). */
  campaign_id: number | null;
  recipient_id: number | null;
  status: string;
  step_index: number;
  branch: CallResult | null;
  branch_index: number;
  call_attempts: number;
  step_failures: number;
  thread_message_id: string | null;
  thread_subject: string | null;
  emails_sent: number;
}
const RUN_COLS = `id, automation_id, user_id, contact_id, form_id, campaign_id, recipient_id, status, step_index, branch, branch_index,
  call_attempts, step_failures, thread_message_id, thread_subject, emails_sent`;

interface AutomationRow {
  id: number;
  name: string;
  kind: string;
  is_active: boolean;
  smtp_settings_id: number | null;
  steps: unknown;
}

interface LeadRow {
  email: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  pipeline_id: number | null;
  stage_id: number | null;
  stage_name: string | null;
  stage_type: string | null;
  stage_position: number | null;
  stage_manual_only: boolean | null;
  stage_stop_follow_ups: boolean | null;
  suppressed: string | null;
  form_name: string | null;
}

async function loadLead(run: Pick<RunRow, 'contact_id' | 'form_id'>): Promise<LeadRow | null> {
  const r = await dbPool.query<LeadRow>(
    `SELECT cc.email, cc.name, cc.company,
            CASE WHEN jsonb_typeof(cc.custom_fields) = 'object' THEN cc.custom_fields->>'phone' END AS phone,
            cc.pipeline_id, cc.stage_id,
            s.name AS stage_name, s.type AS stage_type, s.position AS stage_position,
            s.manual_only AS stage_manual_only, s.stop_follow_ups AS stage_stop_follow_ups,
            (SELECT sl.reason FROM suppression_list sl WHERE lower(sl.email) = lower(cc.email) LIMIT 1) AS suppressed,
            (SELECT f.name FROM crm_forms f WHERE f.id = $2) AS form_name
       FROM crm_contacts cc
       LEFT JOIN crm_pipeline_stages s ON s.id = cc.stage_id
      WHERE cc.id = $1`,
    [run.contact_id, run.form_id ?? -1]
  );
  return r.rows[0] ?? null;
}

const leadFields = (l: LeadRow): LeadFields => ({ email: l.email, name: l.name, company: l.company, phone: l.phone, form: l.form_name });
const who = (l: LeadRow) => (l.name?.trim() ? `${l.name.trim()} (${l.email})` : l.email);


// ─── Saving ─────────────────────────────────────────────────────────────────

type Patch = Partial<{
  status: string;
  step_index: number;
  branch: CallResult | null;
  branch_index: number;
  call_attempts: number;
  step_failures: number;
  thread_message_id: string | null;
  thread_subject: string | null;
  emails_sent: number;
  stop_code: string | null;
  stop_reason: string | null;
  last_error: string | null;
}> & {
  /** next_run_at = now + this many ms; null clears it. */
  nextRunInMs?: number | null;
  finished?: boolean;
};

/** Saves a run that this worker has claimed. False when it is no longer running (stopped by the user meanwhile). */
async function save(runId: number, patch: Patch, db: Db = dbPool): Promise<boolean> {
  const { nextRunInMs, finished, ...cols } = patch;
  const keys = Object.keys(cols) as Array<keyof typeof cols>;
  const params: unknown[] = [runId, ...keys.map((k) => (k === 'last_error' && cols[k] ? String(cols[k]).slice(0, 1000) : cols[k]))];
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  if (nextRunInMs === null) sets.push('next_run_at = NULL');
  else if (nextRunInMs !== undefined) {
    params.push(Math.max(0, nextRunInMs) / 1000);
    sets.push(`next_run_at = now() + make_interval(secs => $${params.length}::double precision)`);
  }
  if (finished) sets.push('finished_at = now()');
  const r = await db.query(
    `UPDATE crm_automation_runs SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1 AND status = 'running'`,
    params
  );
  return (r.rowCount ?? 0) > 0;
}

async function logEvent(run: Pick<RunRow, 'id' | 'user_id'>, kind: string, detail: string | null, smtpSettingsId: number | null = null, db: Db = dbPool) {
  await db.query(
    `INSERT INTO crm_automation_events (run_id, user_id, kind, detail, smtp_settings_id) VALUES ($1, $2, $3, $4, $5)`,
    [run.id, run.user_id, kind, detail ? detail.slice(0, 500) : null, smtpSettingsId]
  );
}

async function completeRun(run: RunRow, note: string | null = null): Promise<void> {
  if (await save(run.id, { status: 'completed', nextRunInMs: null, finished: true, last_error: null })) {
    await logEvent(run, 'completed', note ?? 'All steps done');
  }
}

async function stopRun(run: RunRow, code: string, reason: string): Promise<void> {
  if (await save(run.id, { status: 'stopped', stop_code: code, stop_reason: reason, nextRunInMs: null, finished: true })) {
    await logEvent(run, 'stopped', reason);
  }
}

/** Bell notification (Layout shows it as a CRM update; it opens the lead). */
async function notifyUser(run: RunRow, kind: 'remind' | 'call', message: string): Promise<void> {
  await dbPool.query(`INSERT INTO user_notifications (user_id, type, payload) VALUES ($1, 'crm_automation', $2::jsonb)`, [
    run.user_id,
    JSON.stringify({ contactId: run.contact_id, automationId: run.automation_id, runId: run.id, kind, message: message.slice(0, 500) }),
  ]);
}

// ─── Steps ──────────────────────────────────────────────────────────────────

/** 'next' = go on to the next step; 'pause' = the step saved the run's state (wait, retry later, call). */
type StepOutcome = 'next' | 'pause';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
const textToHtml = (s: string) => `<p style="white-space:pre-wrap;margin:0;">${escapeHtml(s)}</p>`;

/**
 * Null when the account may send now, else why not. countSendsTodayForSmtp counts every email of today:
 * campaigns, follow-ups and automations (max 20 per account per day).
 */
async function smtpLimitProblem(userId: number, smtpId: number): Promise<string | null> {
  const row = await getSmtpProfileRow(userId, smtpId);
  if (!row) return 'The email account of this automation was deleted. Pick another one.';
  const limit = interpretSmtpDailyLimit(row.dailyEmailLimit);
  if (limit === 'unlimited') return null;
  if (limit === 'blocked') return 'The daily limit of the email account is 0. Trying again in 1 hour.';
  const used = await countSendsTodayForSmtp(userId, smtpId);
  return used >= limit.cap ? `Daily limit of the email account reached (${used}/${limit.cap} today). Trying again in 1 hour.` : null;
}

async function emailStep(run: RunRow, auto: AutomationRow, lead: LeadRow, step: EmailStep): Promise<StepOutcome> {
  const smtpId = auto.smtp_settings_id;
  if (smtpId == null) {
    await save(run.id, { status: 'active', nextRunInMs: RETRY_LIMIT_MIN * 60_000, last_error: 'Pick the email account of this automation. Trying again in 1 hour.' });
    return 'pause';
  }
  const limitProblem = await smtpLimitProblem(run.user_id, smtpId);
  if (limitProblem) {
    await save(run.id, { status: 'active', nextRunInMs: RETRY_LIMIT_MIN * 60_000, last_error: limitProblem });
    return 'pause';
  }
  const fields = leadFields(lead);
  const inThread = !step.subject.trim() && run.thread_message_id != null;
  const subject = step.subject.trim()
    ? fillPlaceholders(step.subject, fields).slice(0, 255)
    : run.thread_subject
      ? replySubject(run.thread_subject)
      : null;
  if (!subject) {
    await logEvent(run, 'skipped', 'Email skipped: it has no subject and no earlier email to reply to');
    return 'next';
  }
  const text = fillPlaceholders(step.body, fields);
  try {
    const messageId = await sendEmail({
      userId: run.user_id,
      smtpSettingsId: smtpId,
      to: lead.email,
      subject,
      text,
      html: textToHtml(text),
      ...(inThread ? { inReplyTo: run.thread_message_id!, references: run.thread_message_id! } : {}),
    });
    run.emails_sent += 1;
    const firstEmail = !run.thread_message_id && messageId;
    if (firstEmail) {
      run.thread_message_id = messageId.slice(0, 500);
      run.thread_subject = subject;
    }
    await logEvent(run, 'email', `Sent "${subject}"`, smtpId);
    await save(run.id, {
      emails_sent: run.emails_sent,
      ...(firstEmail ? { thread_message_id: run.thread_message_id, thread_subject: run.thread_subject } : {}),
    });
    return 'next';
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    const tries = run.step_failures + 1;
    if (tries >= MAX_EMAIL_TRIES) {
      await logEvent(run, 'error', `Email "${subject}" not sent after ${tries} tries, skipped: ${msg}`);
      return 'next';
    }
    await logEvent(run, 'error', `Email "${subject}" not sent (try ${tries} of ${MAX_EMAIL_TRIES}): ${msg}`);
    await save(run.id, { status: 'active', step_failures: tries, nextRunInMs: RETRY_FAILED_EMAIL_MIN * 60_000, last_error: `Email not sent: ${msg}` });
    return 'pause';
  }
}

async function stageStep(run: RunRow, auto: AutomationRow, lead: LeadRow, stageId: number): Promise<void> {
  const t = (
    await dbPool.query<{ id: number; pipeline_id: number; name: string; position: number; type: string; manual_only: boolean; stop_follow_ups: boolean }>(
      `SELECT id, pipeline_id, name, position, type, manual_only, stop_follow_ups FROM crm_pipeline_stages WHERE id = $1 AND user_id = $2`,
      [stageId, run.user_id]
    )
  ).rows[0];
  if (!t) return logEvent(run, 'skipped', 'Stage not changed: the stage was deleted');
  if (lead.pipeline_id != null && lead.pipeline_id !== t.pipeline_id) return logEvent(run, 'skipped', `Stage not changed: the lead is in another pipeline`);
  const current: StageInfo | null =
    lead.stage_id != null && lead.pipeline_id === t.pipeline_id
      ? {
          id: lead.stage_id,
          name: lead.stage_name ?? '',
          position: lead.stage_position ?? 0,
          type: lead.stage_type ?? 'normal',
          manualOnly: lead.stage_manual_only === true,
          stopFollowUps: lead.stage_stop_follow_ups === true,
        }
      : null;
  const target: StageInfo = { id: t.id, name: t.name, position: t.position, type: t.type, manualOnly: t.manual_only, stopFollowUps: t.stop_follow_ups };
  const check = canAutoMove(current, target, false);
  if (!check.ok) return logEvent(run, 'skipped', `Stage not changed to "${t.name}": ${check.reason}`);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE crm_contacts SET pipeline_id = $2, stage_id = $3, stage_entered_at = now(), updated_at = now() WHERE id = $1`,
      [run.contact_id, t.pipeline_id, t.id]
    );
    await client.query(
      `INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, reason) VALUES ($1, $2, $3, $4)`,
      [run.contact_id, lead.stage_id, t.id, `Automation: ${auto.name}`.slice(0, 255)]
    );
    if (t.stop_follow_ups) await cancelPendingFollowUps(client, run.contact_id!, `moved to stage "${t.name}" by an automation`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await logEvent(run, 'stage', `Moved to "${t.name}"`);
}

async function callStep(run: RunRow, lead: LeadRow, step: CallStep): Promise<StepOutcome> {
  const attempt = run.call_attempts + 1;
  const phone = lead.phone?.trim() ? ` (${lead.phone.trim()})` : '';
  const extra = step.message ? `: ${fillPlaceholders(step.message, leadFields(lead))}` : '';
  const again = attempt > 1 ? ` (try ${attempt})` : '';
  if (!(await save(run.id, { status: 'waiting_call', call_attempts: attempt, nextRunInMs: null, last_error: null }))) return 'pause';
  await notifyUser(run, 'call', `Call ${who(lead)}${phone}${again}${extra}`);
  await logEvent(run, 'call', `Call reminder${again}`);
  return 'pause';
}

async function runStep(run: RunRow, auto: AutomationRow, lead: LeadRow, step: AutomationStep): Promise<StepOutcome> {
  switch (step.type) {
    case 'wait': {
      const next = run.branch ? { branch_index: run.branch_index + 1 } : { step_index: run.step_index + 1 };
      if (await save(run.id, { ...next, status: 'active', step_failures: 0, last_error: null, nextRunInMs: waitMs(step.amount, step.unit) })) {
        await logEvent(run, 'wait', `Waiting ${step.amount} ${step.amount === 1 ? step.unit.replace(/s$/, '') : step.unit}`);
      }
      return 'pause';
    }
    case 'email':
      return emailStep(run, auto, lead, step);
    case 'remind': {
      const message = fillPlaceholders(step.message, leadFields(lead));
      await notifyUser(run, 'remind', `${who(lead)}: ${message}`);
      await logEvent(run, 'remind', message);
      return 'next';
    }
    case 'tag': {
      const r = await dbPool.query<{ name: string }>(
        `WITH t AS (SELECT id, name FROM crm_tags WHERE id = $2 AND user_id = $3)
         , ins AS (INSERT INTO crm_contact_tags (contact_id, tag_id) SELECT $1, id FROM t ON CONFLICT DO NOTHING)
         SELECT name FROM t`,
        [run.contact_id, step.tagId, run.user_id]
      );
      await logEvent(run, r.rows[0] ? 'tag' : 'skipped', r.rows[0] ? `Tag "${r.rows[0].name}" added` : 'Tag not added: the tag was deleted');
      return 'next';
    }
    case 'stage':
      await stageStep(run, auto, lead, step.stageId);
      return 'next';
    case 'call':
      return callStep(run, lead, step);
  }
}

// ─── Campaign runs (migration 0041) ─────────────────────────────────────────

interface CampaignLeadRow {
  email: string;
  status: string;
  campaign_status: string;
  campaign_smtp_id: number | null;
  suppressed: string | null;
  replied: boolean;
}

async function loadCampaignLead(run: RunRow): Promise<(CampaignLeadRow & { crmBlocked: boolean }) | null> {
  const r = await dbPool.query<CampaignLeadRow>(
    `SELECT r.email, r.status, c.status AS campaign_status, c.smtp_settings_id AS campaign_smtp_id,
            (SELECT sl.reason FROM suppression_list sl WHERE lower(sl.email) = lower(r.email) LIMIT 1) AS suppressed,
            EXISTS (SELECT 1 FROM email_replies er
                     WHERE er.recipient_id = r.id AND er.direction = 'inbound'
                       AND COALESCE(er.label, '') NOT IN ('out_of_office', 'bounce_unsubscribe')) AS replied
       FROM recipients r JOIN campaigns c ON c.id = r.campaign_id
      WHERE r.id = $1`,
    [run.recipient_id]
  );
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, crmBlocked: await isFollowUpBlockedForRecipient(run.recipient_id!) };
}

/** A campaign follow-up: a reply in the campaign's thread from the campaign's account (Inbox + daily limit, like manual follow-ups). */
async function campaignEmailStep(run: RunRow, lead: CampaignLeadRow, step: EmailStep): Promise<StepOutcome> {
  const smtpId = lead.campaign_smtp_id;
  if (smtpId == null) {
    await save(run.id, { status: 'active', nextRunInMs: RETRY_LIMIT_MIN * 60_000, last_error: 'The campaign has no email account. Trying again in 1 hour.' });
    return 'pause';
  }
  const limitProblem = await smtpLimitProblem(run.user_id, smtpId);
  if (limitProblem) {
    await save(run.id, { status: 'active', nextRunInMs: RETRY_LIMIT_MIN * 60_000, last_error: limitProblem });
    return 'pause';
  }
  const res = await sendFollowUpOutbound({
    userId: run.user_id,
    campaignId: run.campaign_id!,
    recipientId: run.recipient_id!,
    subject: '',
    body: step.body,
    followUpTemplateId: null,
    recordQuota: true,
  });
  if (res.ok) {
    run.emails_sent += 1;
    await logEvent(run, 'email', `Follow-up ${run.emails_sent} sent`, smtpId);
    await save(run.id, { emails_sent: run.emails_sent });
    return 'next';
  }
  const tries = run.step_failures + 1;
  if (tries >= MAX_EMAIL_TRIES) {
    await logEvent(run, 'error', `Follow-up not sent after ${tries} tries, skipped: ${res.error}`);
    return 'next';
  }
  await logEvent(run, 'error', `Follow-up not sent (try ${tries} of ${MAX_EMAIL_TRIES}): ${res.error}`);
  await save(run.id, { status: 'active', step_failures: tries, nextRunInMs: RETRY_FAILED_EMAIL_MIN * 60_000, last_error: `Follow-up not sent: ${res.error}` });
  return 'pause';
}

/** Runs a claimed campaign run until it waits, finishes or stops. A reply stops it. */
async function advanceCampaign(run: RunRow): Promise<void> {
  for (let n = 0; n < MAX_STEPS_PER_ROUND; n++) {
    const auto = (
      await dbPool.query<AutomationRow>(`SELECT id, name, kind, is_active, smtp_settings_id, steps FROM crm_automations WHERE id = $1`, [run.automation_id])
    ).rows[0];
    if (!auto) return;
    if (!auto.is_active) {
      await save(run.id, { status: 'active', nextRunInMs: OFF_RECHECK_MIN * 60_000, last_error: 'The automation is off. It continues when you turn it on.' });
      return;
    }
    const lead = await loadCampaignLead(run);
    if (!lead) return; // the recipient was deleted (the run is deleted with it)
    const steps = storedSteps(auto.steps, 'campaign');
    if (run.step_index >= steps.length) return completeRun(run);
    const stop = campaignStopRule(lead);
    if (stop) return stopRun(run, stop.code, stop.reason);
    if (lead.campaign_status === 'paused') {
      await save(run.id, { status: 'active', nextRunInMs: OFF_RECHECK_MIN * 60_000, last_error: 'The campaign is paused. Follow-ups continue when you resume it.' });
      return;
    }
    const step = steps[run.step_index]!;
    if (step.type === 'wait') {
      if (await save(run.id, { step_index: run.step_index + 1, status: 'active', step_failures: 0, last_error: null, nextRunInMs: waitMs(step.amount, step.unit) })) {
        await logEvent(run, 'wait', `Waiting ${step.amount} ${step.amount === 1 ? step.unit.replace(/s$/, '') : step.unit}`);
      }
      return;
    }
    if (step.type !== 'email' || (await campaignEmailStep(run, lead, step)) === 'pause') return;
    run.step_index += 1;
    run.step_failures = 0;
    if (!(await save(run.id, { step_index: run.step_index, step_failures: 0, last_error: null }))) return;
  }
  await save(run.id, { status: 'active', nextRunInMs: 0 });
}

/**
 * Campaign recipients whose first email went out join their campaign's automation (CRM worker, every minute).
 * The automation was picked while the campaign was a draft, so every sent recipient is new to it.
 */
async function enrollCampaignRecipients(limit = 500): Promise<number> {
  const r = await dbPool.query(
    `WITH ins AS (
       INSERT INTO crm_automation_runs (automation_id, user_id, campaign_id, recipient_id, status, next_run_at)
       SELECT ca.automation_id, ca.user_id, r.campaign_id, r.id, 'active', now()
         FROM crm_campaign_automations ca
         JOIN crm_automations a ON a.id = ca.automation_id AND a.kind = 'campaign'
         JOIN recipients r ON r.campaign_id = ca.campaign_id
        WHERE r.message_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM crm_automation_runs x WHERE x.recipient_id = r.id)
        ORDER BY r.id
        LIMIT $1
       ON CONFLICT (recipient_id) WHERE recipient_id IS NOT NULL DO NOTHING
       RETURNING id, user_id)
     INSERT INTO crm_automation_events (run_id, user_id, kind, detail)
     SELECT id, user_id, 'started', 'Started after the first campaign email' FROM ins`,
    [limit]
  );
  return r.rowCount ?? 0;
}

/** Runs a claimed run (status 'running') until it waits, waits for a call, finishes or stops. */
async function advance(run: RunRow): Promise<void> {
  if (run.recipient_id != null) return advanceCampaign(run);
  for (let n = 0; n < MAX_STEPS_PER_ROUND; n++) {
    const auto = (
      await dbPool.query<AutomationRow>(`SELECT id, name, kind, is_active, smtp_settings_id, steps FROM crm_automations WHERE id = $1`, [run.automation_id])
    ).rows[0];
    if (!auto) return; // the automation was deleted (its runs are deleted with it)
    if (!auto.is_active) {
      await save(run.id, { status: 'active', nextRunInMs: OFF_RECHECK_MIN * 60_000, last_error: 'The automation is off. It continues when you turn it on.' });
      return;
    }
    const lead = await loadLead(run);
    if (!lead) return; // the lead was deleted (the run is deleted with it)

    const steps = storedSteps(auto.steps);
    let list: AutomationStep[] | ResultStep[] = steps;
    let index = run.step_index;
    if (run.branch) {
      const call = steps[run.step_index];
      if (!call || call.type !== 'call') return completeRun(run, 'The call step was removed from the automation');
      list = call.outcomes[run.branch];
      index = run.branch_index;
    }
    if (index >= list.length) return completeRun(run);

    const stop = stopRule(lead);
    if (stop) return stopRun(run, stop.code, stop.reason);

    if ((await runStep(run, auto, lead, list[index]!)) === 'pause') return;
    if (run.branch) run.branch_index += 1;
    else run.step_index += 1;
    run.step_failures = 0;
    if (!(await save(run.id, { step_index: run.step_index, branch_index: run.branch_index, step_failures: 0, last_error: null }))) return;
  }
  await save(run.id, { status: 'active', nextRunInMs: 0 });
}

async function advanceSafely(run: RunRow): Promise<void> {
  try {
    await advance(run);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`[automations] run ${run.id} failed:`, err);
    await save(run.id, { status: 'active', nextRunInMs: RETRY_FAILED_EMAIL_MIN * 60_000, last_error: `Something went wrong, trying again in 30 minutes: ${msg}` }).catch(() => undefined);
    await logEvent(run, 'error', msg).catch(() => undefined);
  }
}

// ─── Starting ───────────────────────────────────────────────────────────────

export type EnrollResult = { runId: number } | { skipped: string };

/**
 * Puts a lead in an automation. Skipped when the automation is off or empty, the lead unsubscribed or bounced,
 * the lead is already in it, or the lead finished it less than a day ago.
 */
export async function enrollLead(userId: number, automationId: number, contactId: number, formId: number | null): Promise<EnrollResult> {
  const a = (
    await dbPool.query<{ is_active: boolean; kind: string; steps: unknown }>(
      `SELECT is_active, kind, steps FROM crm_automations WHERE id = $1 AND user_id = $2`,
      [automationId, userId]
    )
  ).rows[0];
  if (!a) return { skipped: 'automation not found' };
  if (kindOf(a.kind) !== 'form') return { skipped: 'a campaign automation cannot be started by a form' };
  if (!a.is_active) return { skipped: 'automation is off' };
  if (storedSteps(a.steps).length === 0) return { skipped: 'automation has no steps' };
  const lead = (
    await dbPool.query<{ suppressed: string | null }>(
      `SELECT (SELECT sl.reason FROM suppression_list sl WHERE lower(sl.email) = lower(cc.email) LIMIT 1) AS suppressed
         FROM crm_contacts cc WHERE cc.id = $1 AND cc.user_id = $2`,
      [contactId, userId]
    )
  ).rows[0];
  if (!lead) return { skipped: 'lead not found' };
  if (lead.suppressed) return { skipped: 'lead unsubscribed or bounced' };
  const last = (
    await dbPool.query<{ status: string; stop_code: string | null; recent: boolean }>(
      `SELECT status, stop_code, COALESCE(finished_at > now() - make_interval(hours => $3), false) AS recent
         FROM crm_automation_runs WHERE automation_id = $1 AND contact_id = $2
        ORDER BY id DESC LIMIT 1`,
      [automationId, contactId, RESTART_AFTER_HOURS]
    )
  ).rows[0];
  if (last) {
    if (OPEN_STATUSES.includes(last.status)) return { skipped: 'lead is already in this automation' };
    if (last.stop_code === 'unsubscribed' || last.stop_code === 'bounced') return { skipped: 'lead unsubscribed or bounced' };
    if (last.recent) return { skipped: 'lead finished this automation less than a day ago' };
  }
  const r = await dbPool.query<{ id: number }>(
    `INSERT INTO crm_automation_runs (automation_id, user_id, contact_id, form_id, status, next_run_at)
     VALUES ($1, $2, $3, $4, 'active', now())
     ON CONFLICT (automation_id, contact_id) WHERE status IN ('active', 'running', 'waiting_call') DO NOTHING
     RETURNING id`,
    [automationId, userId, contactId, formId]
  );
  if (!r.rows[0]) return { skipped: 'lead is already in this automation' };
  await logEvent({ id: r.rows[0].id, user_id: userId }, 'started', formId != null ? 'Started by a form submission' : 'Started');
  return { runId: r.rows[0].id };
}

async function claimRun(runId: number): Promise<RunRow | null> {
  const r = await dbPool.query<RunRow>(
    `UPDATE crm_automation_runs SET status = 'running', updated_at = now()
      WHERE id = $1 AND status = 'active' AND (next_run_at IS NULL OR next_run_at <= now())
      RETURNING ${RUN_COLS}`,
    [runId]
  );
  return r.rows[0] ?? null;
}

/** After a form submit (background): the form's automation starts and its first steps run at once. */
export async function startAutomationForForm(form: { id: number; user_id: number; automation_id?: number | null }, contactId: number): Promise<void> {
  if (!form.automation_id || !(await automationTablesReady())) return;
  const r = await enrollLead(form.user_id, form.automation_id, contactId, form.id);
  if (!('runId' in r)) return;
  const run = await claimRun(r.runId);
  if (run) await advanceSafely(run);
}

// ─── Worker ─────────────────────────────────────────────────────────────────

/**
 * CRM worker, every minute: campaign recipients whose first email went out join their campaign's automation,
 * then runs whose wait is over go on. `planAllows` = the user's plan has the CRM.
 */
export async function processDueAutomationRuns(planAllows: (userId: number) => Promise<boolean>, limit = 50): Promise<{ processed: number; joined: number }> {
  if (!(await automationTablesReady())) return { processed: 0, joined: 0 };
  let joined = 0;
  try {
    joined = await enrollCampaignRecipients();
  } catch (err) {
    console.error('[automations] adding campaign leads failed:', err);
  }
  // A run left 'running' by a crashed worker continues after 30 minutes.
  await dbPool.query(
    `UPDATE crm_automation_runs SET status = 'active', updated_at = now()
      WHERE status = 'running' AND updated_at < now() - interval '30 minutes'`
  );
  const claimed = await dbPool.query<RunRow>(
    `UPDATE crm_automation_runs SET status = 'running', updated_at = now()
      WHERE id IN (
        SELECT id FROM crm_automation_runs
         WHERE status = 'active' AND next_run_at <= now()
         ORDER BY next_run_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING ${RUN_COLS}`,
    [limit]
  );
  const allowed = new Map<number, boolean>();
  for (const run of claimed.rows) {
    if (!allowed.has(run.user_id)) allowed.set(run.user_id, await planAllows(run.user_id).catch(() => false));
    if (!allowed.get(run.user_id)) {
      await save(run.id, { status: 'active', nextRunInMs: 6 * 3_600_000, last_error: 'Your plan does not include the CRM. Waiting.' });
      continue;
    }
    await advanceSafely(run);
  }
  return { processed: claimed.rows.length, joined };
}

/** "Send now": a waiting lead skips the rest of its wait and its next step runs at once. */
export async function sendNow(userId: number, runId: number): Promise<ActionResult> {
  const client = await dbPool.connect();
  let claimed: RunRow | null = null;
  try {
    await client.query('BEGIN');
    const run = (
      await client.query<RunRow>(`SELECT ${RUN_COLS} FROM crm_automation_runs WHERE id = $1 AND user_id = $2 FOR UPDATE`, [runId, userId])
    ).rows[0];
    if (!run || run.status !== 'active') {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'Only a lead that is waiting for its next step can be sent now' };
    }
    const auto = (await client.query<{ kind: string; steps: unknown }>(`SELECT kind, steps FROM crm_automations WHERE id = $1`, [run.automation_id])).rows[0];
    const steps = storedSteps(auto?.steps, kindOf(auto?.kind));
    const call = run.branch ? steps[run.step_index] : null;
    const list = call?.type === 'call' && run.branch ? call.outcomes[run.branch] : steps;
    const index = run.branch ? run.branch_index : run.step_index;
    // The wait the lead is in has already moved the position on; a lead waiting before a wait step skips that wait too.
    const skipWait = list[index]?.type === 'wait';
    const next: { step_index?: number; branch_index?: number } = skipWait ? (run.branch ? { branch_index: index + 1 } : { step_index: index + 1 }) : {};
    await client.query(
      `UPDATE crm_automation_runs
          SET status = 'running', step_index = $2, branch_index = $3, last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [run.id, next.step_index ?? run.step_index, next.branch_index ?? run.branch_index]
    );
    await client.query('COMMIT');
    claimed = { ...run, status: 'running', step_index: next.step_index ?? run.step_index, branch_index: next.branch_index ?? run.branch_index };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await logEvent(claimed, 'skipped', 'Wait skipped: sent now by you');
  await advanceSafely(claimed);
  return { ok: true, message: 'The next step is running now.' };
}

// ─── The user's actions ─────────────────────────────────────────────────────

export type ActionResult = { ok: true; message: string } | { ok: false; status: number; error: string };

/** The user picked the result of a call. "No answer" repeats the call while tries are left, then runs its steps. */
export async function applyCallResult(userId: number, runId: number, result: CallResult): Promise<ActionResult> {
  const client = await dbPool.connect();
  let claimed: RunRow | null = null;
  let message = '';
  try {
    await client.query('BEGIN');
    const run = (
      await client.query<RunRow>(`SELECT ${RUN_COLS} FROM crm_automation_runs WHERE id = $1 AND user_id = $2 FOR UPDATE`, [runId, userId])
    ).rows[0];
    if (!run) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Lead not found in this automation' };
    }
    if (run.status !== 'waiting_call') {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'This lead is not waiting for a call result' };
    }
    const auto = (await client.query<{ steps: unknown }>(`SELECT steps FROM crm_automations WHERE id = $1`, [run.automation_id])).rows[0];
    const call = storedSteps(auto?.steps)[run.step_index];
    await logEvent(run, 'call_result', CALL_RESULT_LABELS[result], null, client);
    if (!call || call.type !== 'call') {
      await client.query(
        `UPDATE crm_automation_runs SET status = 'completed', next_run_at = NULL, finished_at = now(), updated_at = now() WHERE id = $1`,
        [run.id]
      );
      await client.query('COMMIT');
      return { ok: true, message: 'The call step was removed from the automation, so it is finished for this lead.' };
    }
    if (result === 'no_answer' && run.call_attempts <= call.retries) {
      await client.query(
        `UPDATE crm_automation_runs
            SET status = 'active', next_run_at = now() + make_interval(secs => $2::double precision), last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [run.id, waitMs(call.retryAmount, call.retryUnit) / 1000]
      );
      await client.query('COMMIT');
      const unit = call.retryAmount === 1 ? call.retryUnit.replace(/s$/, '') : call.retryUnit;
      return { ok: true, message: `You will be reminded to call again in ${call.retryAmount} ${unit}.` };
    }
    await client.query(
      `UPDATE crm_automation_runs SET status = 'running', branch = $2, branch_index = 0, step_failures = 0, last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [run.id, result]
    );
    await client.query('COMMIT');
    claimed = { ...run, status: 'running', branch: result, branch_index: 0, step_failures: 0 };
    message = `${CALL_RESULT_LABELS[result]}: the next steps are running.`;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await advanceSafely(claimed);
  return { ok: true, message };
}

/** The user stopped one lead's run. */
export async function stopRunByUser(userId: number, runId: number): Promise<ActionResult> {
  const r = await dbPool.query<{ id: number; user_id: number }>(
    `UPDATE crm_automation_runs
        SET status = 'stopped', stop_code = 'manual', stop_reason = 'Stopped by you', next_run_at = NULL, finished_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('active', 'running', 'waiting_call')
      RETURNING id, user_id`,
    [runId, userId]
  );
  if (!r.rows[0]) return { ok: false, status: 404, error: 'This lead is not running in an automation' };
  await logEvent(r.rows[0], 'stopped', 'Stopped by you');
  return { ok: true, message: 'Stopped for this lead.' };
}
