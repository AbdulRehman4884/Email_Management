/**
 * CRM and follow-ups (step 3).
 *
 *  - crmFollowUpBlockedSql(): used by eligibleRecipientsWhere so bulk follow-up jobs skip leads whose
 *    follow-ups were stopped (stop_follow_ups action, bounce, unsubscribe) or who sit in a stage with
 *    "stop follow-ups" on (Interested, Meeting Booked, Won, Lost by default).
 *  - isFollowUpBlockedForRecipient(): the same check for one recipient, right before a send.
 *  - processDueFollowUps(): sends follow-ups planned by the schedule_follow_up action (CRM worker).
 *
 * crm_scheduled_follow_ups.status: pending -> sending -> sent | failed | cancelled.
 */
import type { PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { recipientTable } from '../../db/schema.js';
import { dbPool } from '../db.js';
import { sendFollowUpOutbound } from '../sendFollowUp.js';
import { getSmtpProfileRow } from '../smtpSettings.js';
import { countSendsTodayForSmtp, interpretSmtpDailyLimit } from '../dailySendQuota.js';

type Db = Pick<PoolClient, 'query'>;

/** SQL condition, true when CRM says "no follow-ups" for the recipient row `recipient_id_expr`. */
const BLOCKED_SQL_TEXT = (recipientIdExpr: string) => `EXISTS (
  SELECT 1 FROM crm_contact_recipients ccr
    JOIN crm_contacts cc ON cc.id = ccr.contact_id
    LEFT JOIN crm_pipeline_stages cs ON cs.id = cc.stage_id
   WHERE ccr.recipient_id = ${recipientIdExpr}
     AND (cc.follow_ups_stopped OR COALESCE(cs.stop_follow_ups, false))
)`;

/** Drizzle version for eligibleRecipientsWhere (uses the recipients table of the outer query). */
export function crmFollowUpBlockedSql() {
  return sql`EXISTS (
    SELECT 1 FROM crm_contact_recipients ccr
      JOIN crm_contacts cc ON cc.id = ccr.contact_id
      LEFT JOIN crm_pipeline_stages cs ON cs.id = cc.stage_id
     WHERE ccr.recipient_id = ${recipientTable.id}
       AND (cc.follow_ups_stopped OR COALESCE(cs.stop_follow_ups, false))
  )`;
}

export async function isFollowUpBlockedForRecipient(recipientId: number, db: Db = dbPool): Promise<boolean> {
  const r = await db.query(`SELECT ${BLOCKED_SQL_TEXT('$1')} AS blocked`, [recipientId]);
  return r.rows[0]?.blocked === true;
}

export async function cancelPendingFollowUps(db: Db, contactId: number, reason: string): Promise<number> {
  const r = await db.query(
    `UPDATE crm_scheduled_follow_ups SET status = 'cancelled', error = $2
      WHERE contact_id = $1 AND status = 'pending'`,
    [contactId, reason.slice(0, 1000)]
  );
  return r.rowCount ?? 0;
}

interface DueRow {
  id: number;
  user_id: number;
  contact_id: number;
  recipient_id: number;
  campaign_id: number;
  template_id: string | null;
  created_at: string;
}

async function finish(id: number, status: 'sent' | 'failed' | 'cancelled' | 'pending', error: string | null, retryInMinutes?: number) {
  await dbPool.query(
    `UPDATE crm_scheduled_follow_ups
        SET status = $2::varchar, error = $3::varchar,
            sent_at = CASE WHEN $2::varchar = 'sent' THEN now() ELSE sent_at END,
            due_at = CASE WHEN $4::int IS NULL THEN due_at ELSE now() + make_interval(mins => $4::int) END
      WHERE id = $1`,
    [id, status, error ? error.slice(0, 1000) : null, retryInMinutes ?? null]
  );
}

type Template = { id: string; title?: string; subject: string; body: string };

/** templateId given: that template. Otherwise the first template not sent to this recipient yet, else the last one. */
async function pickTemplate(row: DueRow): Promise<Template | string> {
  const c = await dbPool.query<{ follow_up_templates: Template[] | null; smtp_settings_id: number | null }>(
    `SELECT follow_up_templates, smtp_settings_id FROM campaigns WHERE id = $1 AND user_id = $2`,
    [row.campaign_id, row.user_id]
  );
  const templates = (c.rows[0]?.follow_up_templates ?? []).filter((t) => t && t.id && t.body);
  if (templates.length === 0) return 'the campaign has no follow-up templates';
  if (row.template_id) {
    return templates.find((t) => t.id === row.template_id) ?? `follow-up template "${row.template_id}" was removed from the campaign`;
  }
  const sent = await dbPool.query<{ id: string }>(
    `SELECT DISTINCT follow_up_template_id AS id FROM email_replies
      WHERE recipient_id = $1 AND direction = 'outbound' AND follow_up_template_id IS NOT NULL`,
    [row.recipient_id]
  );
  const sentIds = new Set(sent.rows.map((r) => r.id));
  return templates.find((t) => !sentIds.has(t.id)) ?? templates[templates.length - 1]!;
}

async function smtpQuotaOk(userId: number, campaignId: number): Promise<{ ok: true } | { ok: false; retry: boolean; message: string }> {
  const c = await dbPool.query<{ smtp_settings_id: number | null }>(`SELECT smtp_settings_id FROM campaigns WHERE id = $1`, [campaignId]);
  const smtpId = c.rows[0]?.smtp_settings_id;
  if (!smtpId) return { ok: false, retry: false, message: 'campaign has no SMTP profile' };
  const smtpRow = await getSmtpProfileRow(userId, smtpId);
  if (!smtpRow) return { ok: false, retry: false, message: 'SMTP profile not found' };
  const limit = interpretSmtpDailyLimit(smtpRow.dailyEmailLimit);
  if (limit === 'unlimited') return { ok: true };
  if (limit === 'blocked') return { ok: false, retry: false, message: 'SMTP daily limit is 0' };
  const sent = await countSendsTodayForSmtp(userId, smtpId);
  if (sent >= limit.cap) return { ok: false, retry: true, message: 'SMTP daily limit reached, will retry' };
  return { ok: true };
}

/**
 * Sends due scheduled follow-ups. Claims rows with SKIP LOCKED so two workers never send the same one.
 * Returns how many were handled.
 */
export async function processDueFollowUps(limit = 25): Promise<{ sent: number; cancelled: number; failed: number; retried: number }> {
  const out = { sent: 0, cancelled: 0, failed: 0, retried: 0 };
  // A row stuck in 'sending' (worker crashed mid-send) goes back to pending after 30 minutes.
  await dbPool.query(
    `UPDATE crm_scheduled_follow_ups SET status = 'pending'
      WHERE status = 'sending' AND due_at < now() - interval '30 minutes'`
  );
  const claimed = await dbPool.query<DueRow>(
    `UPDATE crm_scheduled_follow_ups SET status = 'sending'
      WHERE id IN (
        SELECT id FROM crm_scheduled_follow_ups
         WHERE status = 'pending' AND due_at <= now()
         ORDER BY due_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, contact_id, recipient_id, campaign_id, template_id, created_at::text`,
    [limit]
  );

  for (const row of claimed.rows) {
    try {
      if (await isFollowUpBlockedForRecipient(row.recipient_id)) {
        await finish(row.id, 'cancelled', 'follow-ups are stopped for this lead');
        out.cancelled++;
        continue;
      }
      const suppressed = await dbPool.query(
        `SELECT 1 FROM suppression_list s JOIN recipients r ON lower(r.email) = lower(s.email) WHERE r.id = $1 LIMIT 1`,
        [row.recipient_id]
      );
      if (suppressed.rowCount) {
        await finish(row.id, 'cancelled', 'lead unsubscribed or bounced');
        out.cancelled++;
        continue;
      }
      const replied = await dbPool.query(
        `SELECT 1 FROM email_replies er
          WHERE er.recipient_id IN (SELECT recipient_id FROM crm_contact_recipients WHERE contact_id = $1)
            AND er.direction = 'inbound' AND COALESCE(er.label, '') NOT IN ('out_of_office', 'bounce_unsubscribe')
            AND er.received_at::timestamptz > $2::timestamptz
          LIMIT 1`,
        [row.contact_id, row.created_at]
      );
      if (replied.rowCount) {
        await finish(row.id, 'cancelled', 'lead replied before the follow-up was due');
        out.cancelled++;
        continue;
      }
      const tpl = await pickTemplate(row);
      if (typeof tpl === 'string') {
        await finish(row.id, 'failed', tpl);
        out.failed++;
        continue;
      }
      const quota = await smtpQuotaOk(row.user_id, row.campaign_id);
      if (!quota.ok) {
        if (quota.retry) {
          await finish(row.id, 'pending', quota.message, 60);
          out.retried++;
        } else {
          await finish(row.id, 'failed', quota.message);
          out.failed++;
        }
        continue;
      }
      const res = await sendFollowUpOutbound({
        userId: row.user_id,
        campaignId: row.campaign_id,
        recipientId: row.recipient_id,
        subject: tpl.subject,
        body: tpl.body,
        followUpTemplateId: tpl.id,
        recordQuota: true,
      });
      if (res.ok) {
        await finish(row.id, 'sent', null);
        out.sent++;
      } else {
        await finish(row.id, 'failed', res.error);
        out.failed++;
      }
    } catch (err) {
      await finish(row.id, 'failed', (err as Error)?.message ?? String(err)).catch(() => undefined);
      out.failed++;
      console.error(`[crm] scheduled follow-up ${row.id} failed:`, err);
    }
  }
  return out;
}
