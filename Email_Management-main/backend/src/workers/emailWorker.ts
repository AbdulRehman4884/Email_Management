import 'dotenv/config';
import PQueue from 'p-queue';
import { campaignTable, recipientTable, statsTable } from '../db/schema';
import { eq, and, inArray, or, isNotNull } from 'drizzle-orm';
import { db, dbPool } from '../lib/db';
import { normalizeMessageId } from '../lib/messageId.js';
import { sendEmail as sendViaSmtp, getOrCreateTransport } from '../lib/smtp';
import { getCurrentLocalTimestampString } from '../lib/localDateTime';
import type { Recipient } from '../types/reciepients';
import type { Campaign } from '../types/campaign';

// ── Configuration ──

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 20;
const MAX_CONCURRENT_CAMPAIGNS = 50;
const MAX_SMTP_PER_USER = 5;
const MIN_EMAIL_DELAY_MS = 60_000;   // 1 minute
const MAX_EMAIL_DELAY_MS = 120_000;  // 2 minutes

// ── Global state ──

const campaignQueue = new PQueue({ concurrency: MAX_CONCURRENT_CAMPAIGNS });
const activeCampaigns = new Set<number>();

const userSmtpQueues = new Map<number, PQueue>();

function getUserSmtpQueue(userId: number): PQueue {
  let q = userSmtpQueues.get(userId);
  if (!q) {
    q = new PQueue({ concurrency: MAX_SMTP_PER_USER });
    userSmtpQueues.set(userId, q);
  }
  return q;
}

function getRandomDelay(): number {
  return MIN_EMAIL_DELAY_MS + Math.random() * (MAX_EMAIL_DELAY_MS - MIN_EMAIL_DELAY_MS);
}

// ── Helpers ──

function getTrackingBaseUrl(trackingBaseUrl?: string | null): string {
  return (trackingBaseUrl && trackingBaseUrl.trim()) || process.env.TRACKING_BASE_URL || process.env.PUBLIC_URL || 'http://localhost:3000';
}

async function isCampaignInProgress(campaignId: number): Promise<boolean> {
  const [campaign] = await db
    .select({ status: campaignTable.status })
    .from(campaignTable)
    .where(eq(campaignTable.id, campaignId))
    .limit(1);
  return campaign?.status === 'in_progress';
}

type RecipientRow = {
  id: number;
  campaignId: number;
  email: string;
  status: string;
  name: string | null;
  messageId: string | null;
  sentAt: string | null;
  delieveredAt: string | null;
  openedAt: string | null;
  repliedAt: string | null;
};

// ── Send one email (with tracking pixel + unsubscribe) ──

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
  return messageId;
}

// ── Claim a batch of pending recipients for ONE campaign ──

async function claimBatch(campaignId: number): Promise<RecipientRow[]> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE recipients SET status = 'sending' WHERE id IN (
        SELECT id FROM recipients
        WHERE status = 'pending' AND campaign_id = $1
        ORDER BY id LIMIT $2
        FOR UPDATE SKIP LOCKED
      ) RETURNING *`,
      [campaignId, BATCH_SIZE]
    );
    await client.query('COMMIT');
    return (res.rows || []).map((r: Record<string, unknown>) => ({
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
}

// ── De-duplicate within a claimed batch ──

function deduplicateBatch(rows: RecipientRow[]): RecipientRow[] {
  const key = (r: RecipientRow) => `${r.campaignId}\0${r.email.toLowerCase().trim()}`;
  const byKey = new Map<string, RecipientRow>();
  for (const r of rows) {
    const k = key(r);
    const existing = byKey.get(k);
    if (!existing || r.id < existing.id) byKey.set(k, r);
  }
  return Array.from(byKey.values());
}

// ── Send a single recipient (with duplicate-skip & stats) ──

async function sendRecipient(
  recipient: RecipientRow,
  campaign: Campaign,
): Promise<boolean> {
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
    return false;
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
      .set({ status: 'sent', messageId: storedMessageId, sentAt })
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
    return false;
  }

  try {
    const { config } = await getOrCreateTransport(campaign.userId);
    const messageId = await sendOneEmail(
      campaign,
      recipient as Recipient & { id: number },
      config.trackingBaseUrl,
    );

    const storedMessageId = normalizeMessageId(messageId) ?? messageId ?? undefined;
    const sentAt = new Date().toISOString();

    await db
      .update(recipientTable)
      .set({ status: 'sent', messageId: storedMessageId, sentAt })
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

    console.log(`[Worker/Campaign${recipient.campaignId}] Sent to ${recipient.email}, MessageId: ${messageId}`);
    return true;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : '';
    console.error(`[Worker/Campaign${recipient.campaignId}] Failed to send to ${recipient.email}:`, errMsg, errStack || '');

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
    return false;
  }
}

// ── Process one campaign end-to-end ──
// Runs as an independent async task. Loops through all pending recipients,
// sending one at a time with a random 1-2 min delay between sends.
// This delay is LOCAL to this campaign — other campaigns continue in parallel.

async function processCampaign(campaignId: number): Promise<void> {
  const [campaignRow] = await db
    .select()
    .from(campaignTable)
    .where(eq(campaignTable.id, campaignId))
    .limit(1);
  if (!campaignRow || campaignRow.status !== 'in_progress') return;

  const campaign = campaignRow as Campaign;
  const smtpQueue = getUserSmtpQueue(campaign.userId);

  console.log(`[Worker] Starting campaign #${campaignId} "${campaign.name}" (user ${campaign.userId})`);

  let totalSent = 0;
  let isFirstEmail = true;

  while (true) {
    const stillActive = await isCampaignInProgress(campaignId);
    if (!stillActive) {
      console.log(`[Worker] Campaign #${campaignId} no longer in_progress, stopping.`);
      break;
    }

    const batch = await claimBatch(campaignId);
    if (batch.length === 0) break;

    const recipients = deduplicateBatch(batch);

    for (const recipient of recipients) {
      const stillRunning = await isCampaignInProgress(campaignId);
      if (!stillRunning) {
        await db
          .update(recipientTable)
          .set({ status: 'pending' })
          .where(
            and(
              eq(recipientTable.campaignId, campaignId),
              eq(recipientTable.status, 'sending')
            )
          );
        console.log(`[Worker] Campaign #${campaignId} paused/cancelled mid-batch, released remaining recipients.`);
        break;
      }

      if (!isFirstEmail) {
        const delay = getRandomDelay();
        console.log(`[Worker/Campaign${campaignId}] Waiting ${Math.round(delay / 1000)}s before next email...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const sent = await smtpQueue.add(() => sendRecipient(recipient, campaign));
      if (sent) {
        totalSent++;
        isFirstEmail = false;
      }
    }
  }

  console.log(`[Worker] Campaign #${campaignId} finished processing. Total sent: ${totalSent}`);
}

// ── Scheduled campaign activation ──

async function activateScheduledCampaigns(): Promise<void> {
  try {
    const candidates = await dbPool.query(
      `SELECT c.id, c.name, to_char(c.scheduled_at, 'YYYY-MM-DD HH24:MI:SS') AS scheduled_at_local
       FROM campaigns c
       WHERE c.status = 'scheduled'
         AND c.scheduled_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM recipients r
           WHERE r.campaign_id = c.id AND r.status = 'pending'
         )`
    );

    const nowLocal = getCurrentLocalTimestampString();
    const dueIds: number[] = [];
    const dueNamesById = new Map<number, string>();

    for (const row of candidates.rows as Array<{ id: number; name: string; scheduled_at_local: string | null }>) {
      const scheduledAt = String(row.scheduled_at_local || '').slice(0, 19);
      if (!scheduledAt) continue;
      if (scheduledAt <= nowLocal) {
        dueIds.push(row.id);
        dueNamesById.set(row.id, row.name);
      }
    }

    if (dueIds.length > 0) {
      const activated = await dbPool.query(
        `UPDATE campaigns
         SET status = 'in_progress', updated_at = NOW()
         WHERE id = ANY($1::int[]) AND status = 'scheduled'
         RETURNING id`,
        [dueIds]
      );
      for (const row of activated.rows as Array<{ id: number }>) {
        const campaignName = dueNamesById.get(row.id) || 'Unnamed';
        console.log(`[Scheduler] Auto-started campaign #${row.id} "${campaignName}" (scheduled local time reached)`);
      }
    }
  } catch (e) {
    console.error('[Scheduler] Error activating scheduled campaigns:', e);
  }
}

// ── Mark completed campaigns ──

async function markCompletedCampaigns(): Promise<void> {
  try {
    const res = await dbPool.query(
      `UPDATE campaigns c
       SET status = 'completed', updated_at = NOW()
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

// ── Non-blocking poll loop ──
// Discovers in_progress campaigns and queues each one ONCE.
// Does NOT wait for campaigns to finish — just adds new ones to the queue.

async function poll() {
  console.log('Worker started — concurrent multi-campaign mode');
  console.log(`Config: MAX_CONCURRENT_CAMPAIGNS=${MAX_CONCURRENT_CAMPAIGNS}, MAX_SMTP_PER_USER=${MAX_SMTP_PER_USER}, BATCH_SIZE=${BATCH_SIZE}`);
  console.log(`Email delay: random ${MIN_EMAIL_DELAY_MS / 1000}s–${MAX_EMAIL_DELAY_MS / 1000}s between sends (per campaign, non-blocking)`);

  while (true) {
    try {
      await activateScheduledCampaigns();

      const inProgressCampaigns = await db
        .select({ id: campaignTable.id })
        .from(campaignTable)
        .where(eq(campaignTable.status, 'in_progress'));

      for (const c of inProgressCampaigns) {
        if (activeCampaigns.has(c.id)) continue;

        activeCampaigns.add(c.id);
        campaignQueue.add(async () => {
          try {
            await processCampaign(c.id);
          } finally {
            activeCampaigns.delete(c.id);
          }
        });
      }

      await markCompletedCampaigns();
    } catch (error) {
      console.error('[Worker] Poll error:', error);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

poll().catch((error) => {
  console.error('Worker encountered a fatal error:', error);
});
