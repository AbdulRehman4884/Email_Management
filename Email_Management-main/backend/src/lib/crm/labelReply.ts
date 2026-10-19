/**
 * Saves reply labels (CRM step 2) and tells the CRM about them.
 *
 *  - scheduleReplyLabeling(): called right after an inbound reply is saved. Runs in the background
 *    so IMAP / webhook processing is never slowed down or blocked by labeling or AI.
 *  - setManualReplyLabel(): the user changes a label in the Inbox.
 *  - relabelUnlabeledReplies(): labels old replies that have no label yet, in batches.
 */
import { dbPool } from '../db.js';
import { classifyReply } from '../replyLabeling.js';
import type { ReplyLabel, ReplyLabelSource } from '../../constants/replyLabels.js';
import { ensureContactForRecipient } from './contacts.js';
import { emitCrmEvent } from './events.js';
import { recomputeNeedsReply } from './needsReply.js';
import { runCrmInBackground } from './backgroundQueue.js';

interface ReplyRow {
  id: number;
  recipient_id: number;
  from_email: string;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  direction: string;
  label: string | null;
  label_source: string | null;
  user_id: number;
  ai_enabled: boolean | null;
}

async function loadReply(replyId: number): Promise<ReplyRow | null> {
  const res = await dbPool.query<ReplyRow>(
    `SELECT er.id, er.recipient_id, er.from_email, er.subject, er.body_text, er.body_html, er.direction,
            er.label, er.label_source, c.user_id, s.ai_labeling_enabled AS ai_enabled
       FROM email_replies er
       JOIN campaigns c ON c.id = er.campaign_id
       LEFT JOIN crm_settings s ON s.user_id = c.user_id
      WHERE er.id = $1`,
    [replyId]
  );
  return res.rows[0] ?? null;
}

/**
 * Copy the label to the contact. lastReplyLabel / lastInboundAt only move forward in time, so an
 * old reply that is relabeled does not overwrite the label of a newer one.
 */
async function updateContactFromReply(contactId: number, replyId: number): Promise<void> {
  await dbPool.query(
    `UPDATE crm_contacts cc
        SET last_reply_label = CASE
              WHEN NOT EXISTS (
                  SELECT 1 FROM crm_contact_recipients ccr
                    JOIN email_replies newer ON newer.recipient_id = ccr.recipient_id
                   WHERE ccr.contact_id = cc.id AND newer.direction = 'inbound' AND newer.id <> er.id
                     AND newer.label IS NOT NULL
                     AND (newer.received_at, newer.id) > (er.received_at, er.id))
              THEN er.label ELSE cc.last_reply_label END,
            last_inbound_at = GREATEST(cc.last_inbound_at, er.received_at::timestamptz),
            updated_at = now()
       FROM email_replies er
      WHERE cc.id = $1 AND er.id = $2`,
    [contactId, replyId]
  );
}

async function saveLabel(replyId: number, label: ReplyLabel, source: ReplyLabelSource, confidence: number): Promise<void> {
  await dbPool.query(
    `UPDATE email_replies
        SET label = $2, label_source = $3, label_confidence = $4, labeled_at = now()
      WHERE id = $1`,
    [replyId, label, source, Math.round(confidence * 10000) / 10000]
  );
}

export interface LabelReplyOptions {
  headers?: Record<string, string> | null;
  /** Emit reply_received + reply_labeled events (true for new replies, false for old-data relabel). */
  emitEvents?: boolean;
}

/** Classify + save one inbound reply. Manual labels are never overwritten. */
export async function labelInboundReply(replyId: number, options: LabelReplyOptions = {}): Promise<ReplyLabel | null> {
  const reply = await loadReply(replyId);
  if (!reply || reply.direction !== 'inbound') return null;
  if (reply.label_source === 'manual') return reply.label as ReplyLabel;

  const result = await classifyReply(
    {
      fromEmail: reply.from_email,
      subject: reply.subject,
      bodyText: reply.body_text,
      bodyHtml: reply.body_html,
      headers: options.headers ?? null,
    },
    { aiEnabled: reply.ai_enabled === true }
  );
  await saveLabel(replyId, result.label, result.source, result.confidence);

  const contact = await ensureContactForRecipient(reply.recipient_id);
  if (!contact) return result.label;
  await updateContactFromReply(contact.contactId, replyId);
  // Step 6: does the lead now wait for your reply? Old data (relabel) never sends reminders.
  await recomputeNeedsReply(dbPool, [contact.contactId], { markNotified: options.emitEvents === false });

  if (options.emitEvents !== false) {
    await emitCrmEvent(contact.userId, contact.contactId, {
      type: 'reply_received',
      data: { replyId, recipientId: reply.recipient_id, label: result.label },
    });
    await emitCrmEvent(contact.userId, contact.contactId, {
      type: 'reply_labeled',
      data: { replyId, recipientId: reply.recipient_id, label: result.label, previousLabel: reply.label, source: result.source, confidence: result.confidence },
    });
  }
  return result.label;
}

/** Fire-and-forget wrapper used right after a reply is saved. Never throws. */
export function scheduleReplyLabeling(replyId: number, headers?: Record<string, string> | null): void {
  // Step 9: through the CRM queue (a few at a time), so a big IMAP poll is never slowed down.
  runCrmInBackground(`label reply ${replyId}`, () =>
    labelInboundReply(replyId, { headers, emitEvents: true }).catch((err) => {
      console.error(`[crm] labeling reply ${replyId} failed (reply is saved, label left empty):`, err);
    })
  );
}

/**
 * Manual override from the Inbox. Checks the reply belongs to the user.
 * Returns null when the reply is not found / not the user's / not inbound.
 */
export async function setManualReplyLabel(
  userId: number,
  replyId: number,
  label: ReplyLabel
): Promise<{ id: number; label: ReplyLabel; labelSource: 'manual'; labelConfidence: number; labeledAt: string } | null> {
  const owned = await dbPool.query<{ recipient_id: number; label: string | null }>(
    `SELECT er.recipient_id, er.label
       FROM email_replies er
       JOIN campaigns c ON c.id = er.campaign_id
      WHERE er.id = $1 AND c.user_id = $2 AND er.direction = 'inbound'`,
    [replyId, userId]
  );
  const row = owned.rows[0];
  if (!row) return null;

  const updated = await dbPool.query<{ labeled_at: string }>(
    `UPDATE email_replies
        SET label = $2, label_source = 'manual', label_confidence = 1, labeled_at = now()
      WHERE id = $1
      RETURNING labeled_at::text`,
    [replyId, label]
  );

  const contact = await ensureContactForRecipient(row.recipient_id);
  if (contact) {
    await updateContactFromReply(contact.contactId, replyId);
    // Step 6: e.g. relabeled to Out of Office -> no longer waiting for a reply.
    await recomputeNeedsReply(dbPool, [contact.contactId]);
    // Step 3 (rules) and step 7 (scoring) re-run for this contact through this event.
    await emitCrmEvent(contact.userId, contact.contactId, {
      type: 'reply_labeled',
      data: { replyId, recipientId: row.recipient_id, label, previousLabel: row.label, source: 'manual', confidence: 1 },
    });
  }

  return {
    id: replyId,
    label,
    labelSource: 'manual',
    labelConfidence: 1,
    labeledAt: updated.rows[0]?.labeled_at ?? new Date().toISOString(),
  };
}

/**
 * Label the user's old inbound replies that have no label, oldest first, in batches.
 * Does not fire CRM events, so old data does not suddenly move leads between stages.
 */
export async function relabelUnlabeledReplies(
  userId: number,
  opts: { batchSize?: number; maxReplies?: number } = {}
): Promise<{ processed: number; failed: number; remaining: number; byLabel: Record<string, number> }> {
  const batchSize = Math.min(500, Math.max(1, opts.batchSize ?? 200));
  const maxReplies = Math.max(1, opts.maxReplies ?? 2000);
  let processed = 0;
  let failed = 0;
  let lastId = 0;
  const byLabel: Record<string, number> = {};

  while (processed + failed < maxReplies) {
    const take = Math.min(batchSize, maxReplies - processed - failed);
    const batch = await dbPool.query<{ id: number }>(
      `SELECT er.id
         FROM email_replies er
         JOIN campaigns c ON c.id = er.campaign_id
        WHERE c.user_id = $1 AND er.direction = 'inbound' AND er.label IS NULL AND er.id > $2
        ORDER BY er.id ASC
        LIMIT $3`,
      [userId, lastId, take]
    );
    if (batch.rows.length === 0) break;
    for (const { id } of batch.rows) {
      lastId = id;
      try {
        const label = await labelInboundReply(id, { emitEvents: false });
        if (label) byLabel[label] = (byLabel[label] ?? 0) + 1;
        processed++;
      } catch (err) {
        failed++;
        console.error(`[crm] relabel reply ${id} failed:`, err);
      }
    }
  }

  const left = await dbPool.query<{ c: number }>(
    `SELECT count(*)::int AS c
       FROM email_replies er
       JOIN campaigns c ON c.id = er.campaign_id
      WHERE c.user_id = $1 AND er.direction = 'inbound' AND er.label IS NULL`,
    [userId]
  );
  return { processed, failed, remaining: left.rows[0]?.c ?? 0, byLabel };
}
