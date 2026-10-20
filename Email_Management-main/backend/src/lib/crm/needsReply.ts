/**
 * CRM step 6: "needs reply" reminders.
 *
 * A lead needs a reply when a human reply arrived after your last answer from the Inbox (or after you
 * pressed "Mark as done"), and the newest of those replies is not a bounce/unsubscribe.
 * Out-of-office replies never start the waiting time.
 *
 *  - recomputeNeedsReply(): sets crm_contacts.needs_reply / needs_reply_since from the replies.
 *    Called when a reply is labeled (new or changed by hand) and by the migration backfill.
 *  - markReplied(): you answered from the Inbox, or pressed "Mark as done".
 *  - snoozeNeedsReply(): hide a lead until a time; after that it is reminded again.
 *  - processNeedsReplyReminders(): CRM worker, every 15 minutes. One bell notification per waiting
 *    period, after crm_settings.needs_reply_after_hours (half of it when the newest reply is Interested / Question).
 *  - sendNeedsReplyDigests(): CRM worker. Optional daily email (crm_settings.reminder_email_digest)
 *    through the user's own SMTP.
 *
 * Pure helpers (waitingText, reminderDueHours, isPriorityLabel) are unit tested in __tests__/needsReply.test.ts.
 */
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';
import { nonHumanReplySql, replyPlainText, stripQuotedHistory } from '../replyLabeling.js';
import { REPLY_LABEL_META, isReplyLabel } from '../../constants/replyLabels.js';

type Db = Pick<PoolClient, 'query'>;

/** These labels never make a lead "need a reply". */
export const NO_REPLY_NEEDED_LABELS = ['out_of_office', 'bounce_unsubscribe'] as const;
/** These labels are reminded sooner (half the wait) and shown with high priority. */
export const PRIORITY_LABELS = ['interested', 'question'] as const;

export const DEFAULT_NEEDS_REPLY_HOURS = 24;
export const MIN_NEEDS_REPLY_HOURS = 1;
export const MAX_NEEDS_REPLY_HOURS = 24 * 14;
export const MAX_SNOOZE_DAYS = 90;

export function isPriorityLabel(label: string | null | undefined): boolean {
  return (PRIORITY_LABELS as readonly string[]).includes(String(label ?? ''));
}

/** Hours to wait before the reminder. Interested / Question: half. */
export function reminderDueHours(afterHours: number, highPriority: boolean): number {
  const base = Number.isFinite(afterHours) && afterHours > 0 ? afterHours : DEFAULT_NEEDS_REPLY_HOURS;
  return highPriority ? base / 2 : base;
}

/** "waiting 45 min" / "waiting 5 hours" / "waiting 2 days" */
export function waitingText(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return 'waiting';
  if (hours < 1) return `waiting ${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) {
    const h = Math.floor(hours);
    return `waiting ${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.floor(hours / 24);
  return `waiting ${d} days`;
}

/** The replies of one contact that count: inbound, sent by a person. Gives rows (contact_id, id, at, label, ...). */
function inboundRepliesSql(contactExpr: string): string {
  return `SELECT x.contact_id, i.id, i.thread_root_id, i.subject, i.body_text, i.body_html, i.label,
                 i.received_at::timestamptz AS at
            FROM crm_contact_recipients x
            JOIN email_replies i ON i.recipient_id = x.recipient_id
           WHERE x.contact_id = ${contactExpr}
             AND i.direction = 'inbound'
             AND NOT ${nonHumanReplySql('i')}`;
}

/** Time of your last answer: last Inbox reply (not campaign follow-ups) or "Mark as done". */
function answeredAtSql(alias: string): string {
  return `GREATEST(
            COALESCE(${alias}.needs_reply_cleared_at, '-infinity'::timestamptz),
            COALESCE((SELECT max(o.received_at::timestamptz)
                        FROM crm_contact_recipients ox
                        JOIN email_replies o ON o.recipient_id = ox.recipient_id
                       WHERE ox.contact_id = ${alias}.id AND o.direction = 'outbound'
                         AND o.follow_up_template_id IS NULL AND o.follow_up_job_id IS NULL), '-infinity'::timestamptz))`;
}

/**
 * Recomputes needs_reply for some contacts (or all with `contactIds = null`).
 * `markNotified`: for old data (backfill / relabel): flag leads as waiting but do not send reminders for them.
 * Returns how many contacts changed.
 */
export async function recomputeNeedsReply(db: Db, contactIds: number[] | null, opts: { markNotified?: boolean } = {}): Promise<number> {
  if (contactIds && contactIds.length === 0) return 0;
  const noReply = NO_REPLY_NEEDED_LABELS.map((l) => `'${l}'`).join(', ');
  const r = await db.query(
    `WITH target AS (
       SELECT cc.id, ${answeredAtSql('cc')} AS answered_at
         FROM crm_contacts cc
        WHERE ($1::int[] IS NULL OR cc.id = ANY($1::int[]))
     ),
     inbound AS (
       SELECT t.id, r.at, r.label
         FROM target t
         JOIN LATERAL (${inboundRepliesSql('t.id')}) r ON r.at > t.answered_at
     ),
     waiting AS (
       SELECT id,
              min(at) FILTER (WHERE label IS NULL OR label NOT IN (${noReply})) AS since,
              (array_agg(label ORDER BY at DESC))[1] AS latest_label
         FROM inbound
        GROUP BY id
     ),
     next AS (
       SELECT t.id,
              (w.since IS NOT NULL AND COALESCE(w.latest_label, '') <> 'bounce_unsubscribe') AS waiting,
              w.since
         FROM target t LEFT JOIN waiting w ON w.id = t.id
     )
     UPDATE crm_contacts cc
        SET needs_reply = n.waiting,
            needs_reply_since = CASE WHEN n.waiting THEN n.since END,
            needs_reply_notified_at = CASE
                WHEN NOT n.waiting THEN NULL
                WHEN $2::boolean THEN COALESCE(cc.needs_reply_notified_at, now())
                WHEN cc.needs_reply AND cc.needs_reply_since = n.since THEN cc.needs_reply_notified_at
                ELSE NULL END,
            snoozed_until = CASE WHEN n.waiting THEN cc.snoozed_until END,
            updated_at = now()
       FROM next n
      WHERE cc.id = n.id
        AND (cc.needs_reply IS DISTINCT FROM n.waiting
             OR cc.needs_reply_since IS DISTINCT FROM (CASE WHEN n.waiting THEN n.since END))`,
    [contactIds, opts.markNotified === true]
  );
  return r.rowCount ?? 0;
}

/** You answered (Inbox reply) or pressed "Mark as done": the lead no longer waits. */
export async function markReplied(db: Db, contactId: number): Promise<void> {
  await db.query(
    `UPDATE crm_contacts
        SET needs_reply = false, needs_reply_since = NULL, needs_reply_notified_at = NULL, snoozed_until = NULL,
            needs_reply_cleared_at = now(), updated_at = now()
      WHERE id = $1`,
    [contactId]
  );
}

/** After an Inbox reply to a recipient. Never throws (the email is already sent). */
export async function markRepliedForRecipient(recipientId: number): Promise<void> {
  try {
    const r = await dbPool.query<{ contact_id: number }>(`SELECT contact_id FROM crm_contact_recipients WHERE recipient_id = $1`, [recipientId]);
    if (r.rows[0]) await markReplied(dbPool, r.rows[0].contact_id);
  } catch (err) {
    console.error(`[crm] could not clear "needs reply" for recipient ${recipientId}:`, err);
  }
}

/** Hide until `until`. The reminder is sent again after that if the lead still waits. */
export async function snoozeNeedsReply(db: Db, contactId: number, until: Date): Promise<void> {
  await db.query(
    `UPDATE crm_contacts SET snoozed_until = $2, needs_reply_notified_at = NULL, updated_at = now() WHERE id = $1`,
    [contactId, until.toISOString()]
  );
}

export interface WaitingLead {
  contactId: number;
  email: string;
  name: string | null;
  company: string | null;
  score: number;
  scoreTier: string;
  stageName: string | null;
  stageColor: string | null;
  since: string;
  waitingHours: number;
  dueHours: number;
  overdue: boolean;
  priority: 'high' | 'normal';
  snoozedUntil: string | null;
  reminded: boolean;
  /** Newest waiting reply: opens the conversation in the Inbox. */
  replyId: number | null;
  threadRootId: number | null;
  label: string | null;
  subject: string | null;
  snippet: string;
}

type WaitingRow = {
  id: number; user_id: number; email: string; name: string | null; company: string | null; score: number; score_tier: string;
  stage_name: string | null; stage_color: string | null; since: string; snoozed_until: string | null; notified_at: string | null;
  after_hours: number | null; waiting_hours: number | string; high: boolean; reply_id: number | null; thread_root_id: number | null;
  label: string | null; subject: string | null; body_text: string | null; body_html: string | null;
};

/** Waiting leads with their newest waiting reply. Shared by the API, the reminder job and the digest. */
function waitingLeadsSql(where: string, orderAndLimit: string): string {
  const prio = PRIORITY_LABELS.map((l) => `'${l}'`).join(', ');
  return `SELECT cc.id, cc.user_id, cc.email, cc.name, cc.company, cc.score, cc.score_tier,
                 s.name AS stage_name, s.color AS stage_color,
                 cc.needs_reply_since AS since, cc.snoozed_until, cc.needs_reply_notified_at AS notified_at,
                 st.needs_reply_after_hours AS after_hours,
                 EXTRACT(EPOCH FROM (now() - cc.needs_reply_since)) / 3600 AS waiting_hours,
                 COALESCE(lr.label IN (${prio}), false) AS high,
                 lr.id AS reply_id, COALESCE(lr.thread_root_id, lr.id) AS thread_root_id, lr.label, lr.subject, lr.body_text, lr.body_html
            FROM crm_contacts cc
            LEFT JOIN crm_pipeline_stages s ON s.id = cc.stage_id
            LEFT JOIN crm_settings st ON st.user_id = cc.user_id
            LEFT JOIN LATERAL (
              SELECT r.* FROM (${inboundRepliesSql('cc.id')}) r
               WHERE r.at >= cc.needs_reply_since
               ORDER BY r.at DESC, r.id DESC LIMIT 1) lr ON true
           WHERE cc.needs_reply AND cc.needs_reply_since IS NOT NULL AND ${where}
           ${orderAndLimit}`;
}

function snippetOf(row: Pick<WaitingRow, 'body_text' | 'body_html'>, max = 160): string {
  const text = stripQuotedHistory(replyPlainText({ bodyText: row.body_text, bodyHtml: row.body_html })).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toLead(r: WaitingRow): WaitingLead {
  const waitingHours = Math.max(0, Number(r.waiting_hours) || 0);
  const dueHours = reminderDueHours(Number(r.after_hours ?? DEFAULT_NEEDS_REPLY_HOURS), r.high);
  return {
    contactId: r.id,
    email: r.email,
    name: r.name,
    company: r.company,
    score: r.score,
    scoreTier: r.score_tier,
    stageName: r.stage_name,
    stageColor: r.stage_color,
    since: r.since,
    waitingHours: Math.round(waitingHours * 10) / 10,
    dueHours,
    overdue: waitingHours >= dueHours,
    priority: r.high ? 'high' : 'normal',
    snoozedUntil: r.snoozed_until,
    reminded: r.notified_at != null,
    replyId: r.reply_id,
    threadRootId: r.thread_root_id,
    label: r.label,
    subject: r.subject,
    snippet: snippetOf(r),
  };
}

/** For the Inbox "Needs reply" tab. Overdue first, then high priority, then longest waiting. */
export async function listWaitingLeads(userId: number, opts: { includeSnoozed?: boolean; limit?: number } = {}) {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const r = await dbPool.query<WaitingRow>(
    waitingLeadsSql(`cc.user_id = $1`, `ORDER BY cc.needs_reply_since ASC LIMIT ${limit}`),
    [userId]
  );
  const all = r.rows.map(toLead);
  const now = Date.now();
  const isSnoozed = (l: WaitingLead) => l.snoozedUntil != null && new Date(l.snoozedUntil).getTime() > now;
  const active = all.filter((l) => !isSnoozed(l));
  const snoozed = all.filter(isSnoozed);
  const rank = (l: WaitingLead) => (l.overdue ? 0 : 2) + (l.priority === 'high' ? 0 : 1);
  active.sort((a, b) => rank(a) - rank(b) || b.waitingHours - a.waitingHours);
  return {
    leads: opts.includeSnoozed ? [...active, ...snoozed] : active,
    counts: { waiting: active.length, overdue: active.filter((l) => l.overdue).length, snoozed: snoozed.length },
  };
}

/**
 * CRM worker job: one bell notification per waiting period, once the lead waited long enough and is
 * not snoozed. `planAllows(userId)` skips users without CRM in their plan.
 */
export async function processNeedsReplyReminders(
  planAllows: (userId: number) => Promise<boolean>,
  limit = 200
): Promise<{ created: number; skipped: number }> {
  const prio = PRIORITY_LABELS.map((l) => `'${l}'`).join(', ');
  const client = await dbPool.connect();
  let created = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    // Lock the candidates so two workers never notify the same lead twice.
    const due = await client.query<{ id: number }>(
      `SELECT cc.id
         FROM crm_contacts cc
         LEFT JOIN crm_settings st ON st.user_id = cc.user_id
        WHERE cc.needs_reply AND cc.needs_reply_since IS NOT NULL
          AND (cc.snoozed_until IS NULL OR cc.snoozed_until <= now())
          AND (cc.needs_reply_notified_at IS NULL OR cc.needs_reply_notified_at < cc.needs_reply_since)
          AND EXTRACT(EPOCH FROM (now() - cc.needs_reply_since)) / 3600 >=
              COALESCE(st.needs_reply_after_hours, ${DEFAULT_NEEDS_REPLY_HOURS})::numeric
              * CASE WHEN (SELECT p.label FROM (${inboundRepliesSql('cc.id')}) p
                            WHERE p.at >= cc.needs_reply_since
                            ORDER BY p.at DESC, p.id DESC LIMIT 1) IN (${prio}) THEN 0.5 ELSE 1 END
        ORDER BY cc.needs_reply_since ASC
        LIMIT $1
        FOR UPDATE OF cc SKIP LOCKED`,
      [limit]
    );
    if (due.rows.length > 0) {
      const rows = await client.query<WaitingRow>(waitingLeadsSql(`cc.id = ANY($1::int[])`, ''), [due.rows.map((d) => d.id)]);
      const allowed = new Map<number, boolean>();
      for (const row of rows.rows) {
        if (!allowed.has(row.user_id)) allowed.set(row.user_id, await planAllows(row.user_id).catch(() => false));
        if (!allowed.get(row.user_id)) {
          skipped++;
          continue;
        }
        const lead = toLead(row);
        const who = lead.name || lead.email;
        const labelName = isReplyLabel(lead.label) ? REPLY_LABEL_META[lead.label].name : null;
        const payload = {
          contactId: lead.contactId,
          email: lead.email,
          name: lead.name,
          label: lead.label,
          replySnippet: lead.snippet,
          waitingHours: Math.round(lead.waitingHours),
          priority: lead.priority,
          replyId: lead.replyId,
          threadRootId: lead.threadRootId,
          message: `${who} is ${waitingText(lead.waitingHours)} for your reply${labelName ? ` (${labelName})` : ''}`,
        };
        await client.query(`INSERT INTO user_notifications (user_id, type, payload) VALUES ($1, 'needs_reply', $2::jsonb)`, [
          row.user_id,
          JSON.stringify(payload),
        ]);
        await client.query(`UPDATE crm_contacts SET needs_reply_notified_at = now() WHERE id = $1`, [row.id]);
        created++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { created, skipped };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Builds the digest email. Pure: unit tested. */
export function buildDigestEmail(leads: WaitingLead[], appUrl: string | null): { subject: string; html: string; text: string } {
  const n = leads.length;
  const subject = `${n} lead${n === 1 ? ' is' : 's are'} waiting for your reply`;
  const link = appUrl ? `${appUrl.replace(/\/+$/, '')}/inbox?tab=needs_reply` : null;
  const lines = leads.map((l) => {
    const label = isReplyLabel(l.label) ? REPLY_LABEL_META[l.label] : null;
    return { l, label };
  });
  const text = [
    `${subject}:`,
    '',
    ...lines.map(({ l, label }) =>
      `- ${l.name ? `${l.name} <${l.email}>` : l.email} · ${waitingText(l.waitingHours)}${label ? ` · ${label.name}` : ''} · score ${l.score}${l.snippet ? `\n  "${l.snippet}"` : ''}`
    ),
    '',
    link ? `Open the Inbox: ${link}` : 'Open the Inbox → Needs reply.',
  ].join('\n');
  const rows = lines
    .map(
      ({ l, label }) => `<tr>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;">
    <strong>${esc(l.name || l.email)}</strong>${l.name ? `<br><span style="color:#6b7280;font-size:12px;">${esc(l.email)}</span>` : ''}
    ${l.snippet ? `<div style="color:#4b5563;font-size:12px;margin-top:4px;">“${esc(l.snippet)}”</div>` : ''}
  </td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap;font-size:13px;">${label ? `<span style="display:inline-block;width:8px;height:8px;border-radius:8px;background:${label.color};margin-right:6px;"></span>${esc(label.name)}` : ''}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap;font-size:13px;color:${l.overdue ? '#b91c1c' : '#374151'};">${esc(waitingText(l.waitingHours))}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-size:13px;">${l.score}</td>
</tr>`
    )
    .join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;">
<h2 style="font-size:18px;margin:0 0 12px;">${esc(subject)}</h2>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:680px;">
<tr style="text-align:left;color:#6b7280;font-size:12px;"><th style="padding:6px 10px;">Lead</th><th style="padding:6px 10px;">Last reply</th><th style="padding:6px 10px;">Waiting</th><th style="padding:6px 10px;text-align:right;">Score</th></tr>
${rows}
</table>
${link ? `<p style="margin-top:16px;"><a href="${esc(link)}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;">Open the Inbox</a></p>` : ''}
<p style="color:#9ca3af;font-size:12px;margin-top:16px;">You get this email because the daily digest is on in Settings → CRM.</p>
</div>`;
  return { subject, html, text };
}

/**
 * CRM worker job: the daily digest, at most once per day per user, from `digestHour` (server time).
 * Sent through the user's own SMTP (default profile). Days without waiting leads send nothing.
 */
export async function sendNeedsReplyDigests(opts: {
  digestHour: number;
  appUrl: string | null;
  planAllows: (userId: number) => Promise<boolean>;
  send: (args: { userId: number; to: string; subject: string; html: string; text: string }) => Promise<unknown>;
}): Promise<{ sent: number; empty: number; failed: number }> {
  const out = { sent: 0, empty: 0, failed: 0 };
  const users = await dbPool.query<{ user_id: number; email: string }>(
    `SELECT st.user_id, u.email
       FROM crm_settings st JOIN users u ON u.id = st.user_id
      WHERE st.reminder_email_digest
        AND EXTRACT(HOUR FROM now()) >= $1
        AND (st.last_digest_sent_at IS NULL OR st.last_digest_sent_at < date_trunc('day', now()))`,
    [opts.digestHour]
  );
  for (const u of users.rows) {
    // Claim the day first, so a slow SMTP never causes a second email.
    const claim = await dbPool.query(
      `UPDATE crm_settings SET last_digest_sent_at = now()
        WHERE user_id = $1 AND (last_digest_sent_at IS NULL OR last_digest_sent_at < date_trunc('day', now()))`,
      [u.user_id]
    );
    if (!claim.rowCount) continue;
    if (!(await opts.planAllows(u.user_id).catch(() => false))) continue;
    const r = await dbPool.query<WaitingRow>(
      waitingLeadsSql(`cc.user_id = $1 AND (cc.snoozed_until IS NULL OR cc.snoozed_until <= now())`, `ORDER BY cc.score DESC, cc.needs_reply_since ASC LIMIT 50`),
      [u.user_id]
    );
    if (r.rows.length === 0) {
      out.empty++;
      continue;
    }
    const mail = buildDigestEmail(r.rows.map(toLead), opts.appUrl);
    try {
      await opts.send({ userId: u.user_id, to: u.email, ...mail });
      out.sent++;
    } catch (err) {
      out.failed++;
      const message = `The daily "waiting for your reply" email could not be sent: ${(err as Error)?.message ?? 'SMTP error'}. Check your SMTP settings.`;
      await dbPool
        .query(`INSERT INTO user_notifications (user_id, type, payload) VALUES ($1, 'crm_digest_failed', $2::jsonb)`, [u.user_id, JSON.stringify({ message })])
        .catch(() => undefined);
    }
  }
  return out;
}
