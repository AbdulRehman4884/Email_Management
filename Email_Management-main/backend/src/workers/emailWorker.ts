import 'dotenv/config'
import { campaignTable, recipientTable, statsTable } from '../db/schema';
import { eq, and, inArray, or, isNotNull } from 'drizzle-orm';
import { db, dbPool } from '../lib/db';
import { getSmtpSettings } from '../lib/smtpSettings';
import { normalizeMessageId } from '../lib/messageId.js';
import { sendEmail as sendViaSmtp } from '../lib/smtp';
import type { Recipient } from '../types/reciepients';
import type { Campaign } from '../types/campaign';

const POLL_INTERVAL_MS = 1500;
const BATCH_SIZE = 10;
const FIXED_SEND_INTERVAL_MS = 180_000; // 3 minutes per user

// Per-user rate limiting: each user gets their own send timer
const lastSendTimeByUser = new Map<number, number>();

function getUserLastSendTime(userId: number): number {
  return lastSendTimeByUser.get(userId) || 0;
}

function setUserLastSendTime(userId: number): void {
  lastSendTimeByUser.set(userId, Date.now());
}

function getTrackingBaseUrl(trackingBaseUrl?: string | null): string {
  return (trackingBaseUrl && trackingBaseUrl.trim()) || process.env.TRACKING_BASE_URL || process.env.PUBLIC_URL || 'http://localhost:3000';
}

async function sendOneEmail(
  campaign: Campaign,
  recipient: Recipient & { id: number },
  trackingBaseUrl?: string | null
): Promise<string> {
  let htmlBody = campaign.emailContent;
  htmlBody = htmlBody
    .replace(/{{firstName}}/g, recipient.name?.split(' ')[0] || '')
    .replace(/{{email}}/g, recipient.email);

  const baseUrl = getTrackingBaseUrl(trackingBaseUrl);
  const trackingUrl = `${baseUrl}/api/track/open?r=${recipient.id}`;
  const trackingPixel = `<img src="${trackingUrl}" width="1" height="1" alt="" style="display:none" />`;
  if (htmlBody.includes('</body>')) {
    htmlBody = htmlBody.replace('</body>', `${trackingPixel}</body>`);
  } else {
    htmlBody = htmlBody + trackingPixel;
  }

  const unsubscribeBaseUrl = process.env.UNSUBSCRIBE_BASE_URL || process.env.TRACKING_BASE_URL || process.env.PUBLIC_URL;
  const listUnsubscribeUrl = unsubscribeBaseUrl
    ? `${unsubscribeBaseUrl.replace(/\/$/, '')}/api/unsubscribe?email=${encodeURIComponent(recipient.email)}`
    : undefined;

  const messageId = await sendViaSmtp({
    to: recipient.email,
    subject: campaign.subject,
    html: htmlBody,
    fromName: campaign.fromName,
    fromEmail: campaign.fromEmail,
    listUnsubscribeUrl,
    userId: campaign.userId,
  });
  setUserLastSendTime(campaign.userId);
  return messageId;
}

async function isCampaignInProgress(campaignId: number): Promise<boolean> {
  const [campaign] = await db
    .select({ status: campaignTable.status })
    .from(campaignTable)
    .where(eq(campaignTable.id, campaignId))
    .limit(1);
  return campaign?.status === 'in_progress';
}

type RecipientRow = { id: number; campaignId: number; email: string; status: string; name: string | null; messageId: string | null; sentAt: string | null; delieveredAt: string | null; openedAt: string | null; repliedAt: string | null };

/**
 * Process a batch of recipients for a single user.
 * Each user runs independently with their own rate limit.
 */
async function processUserBatch(userId: number, campaignIds: number[]): Promise<number> {
  const client = await dbPool.connect();
  let pendingRecipients: RecipientRow[] = [];
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE recipients SET status = 'sending' WHERE id IN (
        SELECT id FROM recipients
        WHERE status = 'pending' AND campaign_id = ANY($1::int[])
        ORDER BY id LIMIT $2
        FOR UPDATE SKIP LOCKED
      ) RETURNING *`,
      [campaignIds, BATCH_SIZE]
    );
    await client.query('COMMIT');
    const rows = (res.rows || []) as Record<string, unknown>[];
    pendingRecipients = rows.map((r) => ({
      id: r.id as number,
      campaignId: r.campaign_id as number,
      email: r.email as string,
      status: r.status as string,
      name: r.name as string | null,
      messageId: r.message_id as string | null,
      sentAt: r.sent_at as string | null,
      delieveredAt: r.delievered_at as string | null,
      openedAt: r.opened_at as string | null,
      repliedAt: r.replied_at as string | null,
    }));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  if (pendingRecipients.length === 0) {
    return 0;
  }

  const campaignIdsNeeded = [...new Set(pendingRecipients.map((r) => r.campaignId))];
  const campaigns = await db
    .select()
    .from(campaignTable)
    .where(inArray(campaignTable.id, campaignIdsNeeded));
  const campaignMap = new Map(campaigns.map((c) => [c.id, c as Campaign]));

  const key = (r: { campaignId: number; email: string }) => `${r.campaignId}\0${r.email.toLowerCase().trim()}`;
  const byKey = new Map<string, (typeof pendingRecipients)[0]>();
  for (const r of pendingRecipients) {
    const k = key(r);
    const existing = byKey.get(k);
    if (!existing || r.id < existing.id) byKey.set(k, r);
  }
  const toSend = Array.from(byKey.values());

  let processed = 0;
  for (const recipient of toSend) {
    const campaign = campaignMap.get(recipient.campaignId);
    if (!campaign) continue;
    const canSend = await isCampaignInProgress(recipient.campaignId);
    if (!canSend) {
      await db
        .update(recipientTable)
        .set({ status: 'pending' })
        .where(
          and(
            eq(recipientTable.campaignId, recipient.campaignId),
            eq(recipientTable.email, recipient.email),
            eq(recipientTable.status, 'sending')
          )
        );
      continue;
    }

    const sameEmailSent = await db
      .select({ id: recipientTable.id, messageId: recipientTable.messageId })
      .from(recipientTable)
      .where(
        and(
          eq(recipientTable.campaignId, recipient.campaignId),
          eq(recipientTable.email, recipient.email),
          or(eq(recipientTable.status, 'sent'), isNotNull(recipientTable.messageId))
        )
      )
      .limit(1);
    if (sameEmailSent[0] && sameEmailSent[0].id !== recipient.id) {
      const sentAt = new Date().toISOString();
      const storedMessageId = sameEmailSent[0].messageId ?? undefined;
      await db
        .update(recipientTable)
        .set({
          status: 'sent',
          messageId: storedMessageId,
          sentAt,
        })
        .where(eq(recipientTable.id, recipient.id));
      await db
        .update(recipientTable)
        .set({ status: 'sent', messageId: storedMessageId, sentAt })
        .where(
          and(
            eq(recipientTable.campaignId, recipient.campaignId),
            eq(recipientTable.email, recipient.email),
            eq(recipientTable.status, 'sending')
          )
        );
      console.log(`[Worker] Skipped duplicate send to ${recipient.email} (campaign ${recipient.campaignId}); already sent.`);
      continue;
    }

    try {
      const timeSinceLastSend = Date.now() - getUserLastSendTime(userId);
      if (timeSinceLastSend < FIXED_SEND_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, FIXED_SEND_INTERVAL_MS - timeSinceLastSend));
      }
      const stillInProgress = await isCampaignInProgress(recipient.campaignId);
      if (!stillInProgress) {
        await db
          .update(recipientTable)
          .set({ status: 'pending' })
          .where(
            and(
              eq(recipientTable.campaignId, recipient.campaignId),
              eq(recipientTable.email, recipient.email),
              eq(recipientTable.status, 'sending')
            )
          );
        continue;
      }
      const messageId = await sendOneEmail(campaign, recipient as Recipient & { id: number });

      const storedMessageId = normalizeMessageId(messageId) ?? messageId ?? undefined;
      const sentAt = new Date().toISOString();

      await db
        .update(recipientTable)
        .set({
          status: 'sent',
          messageId: storedMessageId,
          sentAt,
        })
        .where(eq(recipientTable.id, recipient.id));

      await db
        .update(recipientTable)
        .set({ status: 'sent', messageId: storedMessageId, sentAt })
        .where(
          and(
            eq(recipientTable.campaignId, recipient.campaignId),
            eq(recipientTable.email, recipient.email),
            eq(recipientTable.status, 'sending')
          )
        );

      const stats = await db
        .select()
        .from(statsTable)
        .where(eq(statsTable.campaignId, recipient.campaignId))
        .limit(1);
      if (stats[0]) {
        await db
          .update(statsTable)
          .set({ sentCount: Number(stats[0].sentCount) + 1 })
          .where(eq(statsTable.campaignId, recipient.campaignId));
      }

      console.log(`[Worker/User${userId}] Sent to ${recipient.email}, MessageId: ${messageId}`);
      processed++;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : '';
      console.error(`[Worker/User${userId}] Failed to send to ${recipient.email}:`, errMsg, errStack || '');
      await db
        .update(recipientTable)
        .set({ status: 'failed' })
        .where(eq(recipientTable.id, recipient.id));
      await db
        .update(recipientTable)
        .set({ status: 'pending' })
        .where(
          and(
            eq(recipientTable.campaignId, recipient.campaignId),
            eq(recipientTable.email, recipient.email),
            eq(recipientTable.status, 'sending')
          )
        );

      const stats = await db
        .select()
        .from(statsTable)
        .where(eq(statsTable.campaignId, recipient.campaignId))
        .limit(1);
      if (stats[0]) {
        await db
          .update(statsTable)
          .set({ failedCount: Number(stats[0].failedCount) + 1 })
          .where(eq(statsTable.campaignId, recipient.campaignId));
      }
    }
  }

  return processed;
}

/**
 * Groups in-progress campaigns by userId and processes each user's
 * batch concurrently so different users don't block each other.
 */
async function processBatch() {
  const inProgressCampaigns = await db
    .select({ id: campaignTable.id, userId: campaignTable.userId })
    .from(campaignTable)
    .where(eq(campaignTable.status, 'in_progress'));

  if (inProgressCampaigns.length === 0) {
    return 0;
  }

  const campaignsByUser = new Map<number, number[]>();
  for (const c of inProgressCampaigns) {
    const ids = campaignsByUser.get(c.userId) || [];
    ids.push(c.id);
    campaignsByUser.set(c.userId, ids);
  }

  const results = await Promise.allSettled(
    Array.from(campaignsByUser.entries()).map(([userId, campaignIds]) =>
      processUserBatch(userId, campaignIds)
    )
  );

  let totalProcessed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      totalProcessed += result.value;
    } else {
      console.error('[Worker] User batch failed:', result.reason);
    }
  }

  return totalProcessed;
}

async function activateScheduledCampaigns(): Promise<void> {
  try {
    const res = await dbPool.query(
      `UPDATE campaigns
       SET status = 'in_progress'
       WHERE status = 'scheduled'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= NOW()
         AND EXISTS (
           SELECT 1 FROM recipients r
           WHERE r.campaign_id = campaigns.id AND r.status = 'pending'
         )
       RETURNING id, name`
    );
    if (res.rowCount && res.rowCount > 0) {
      for (const row of res.rows as Array<{ id: number; name: string }>) {
        console.log(`[Scheduler] Auto-started campaign #${row.id} "${row.name}" (scheduled time reached)`);
      }
    }
  } catch (e) {
    console.error('[Scheduler] Error activating scheduled campaigns:', e);
  }
}

/** Set campaign status to completed when no recipients are pending or sending. */
async function markCompletedCampaigns(): Promise<void> {
  try {
    const res = await dbPool.query(
      `UPDATE campaigns c
       SET status = 'completed'
       WHERE c.status = 'in_progress'
         AND NOT EXISTS (
           SELECT 1 FROM recipients r
           WHERE r.campaign_id = c.id AND r.status IN ('pending', 'sending')
         )`
    );
    if (res.rowCount && res.rowCount > 0) {
      console.log(`[Worker] Marked ${res.rowCount} campaign(s) as completed.`);
    }
  } catch (e) {
    console.error('[Worker] Error marking campaigns completed:', e);
  }
}

async function poll() {
  console.log('Worker polling database for pending emails (SMTP)...');
  console.log('SMTP host:', process.env.SMTP_HOST || '(not set)', '| User:', process.env.SMTP_USER || '(not set)');
  console.log('Per-user send interval:', `${FIXED_SEND_INTERVAL_MS}ms`, '| Mode:', 'concurrent per user');

  while (true) {
    try {
      await activateScheduledCampaigns();
      const processed = await processBatch();
      await markCompletedCampaigns();
      if (processed === 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (error) {
      console.error('Error in worker:', error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

poll().catch((error) => {
  console.error('Worker encountered a fatal error:', error);
});
