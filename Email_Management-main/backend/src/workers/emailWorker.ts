import 'dotenv/config';
import PQueue from 'p-queue';
import { campaignTable, recipientTable, statsTable } from '../db/schema';
import { eq, and, inArray, or, isNotNull, count, sql } from 'drizzle-orm';
import { db, dbPool } from '../lib/db';
import { normalizeMessageId } from '../lib/messageId.js';
import { sendEmail as sendViaSmtp, getOrCreateTransport } from '../lib/smtp';
import { getCurrentLocalTimestampString, isScheduledTimeReached, parseLocalTimestamp } from '../lib/localDateTime';
import type { Recipient } from '../types/reciepients';
import type { Campaign } from '../types/campaign';
import { replacePlaceholders } from '../lib/replacePlaceholders';
import { getSmtpProfileRow } from '../lib/smtpSettings';
import {
  countSendsTodayForCampaign,
  countSendsTodayForSmtp,
  insertLimitNotification,
  PAUSE_DAILY_CAMPAIGN_CAP,
  PAUSE_SMTP_DAILY_LIMIT,
  recordSuccessfulSend,
} from '../lib/dailySendQuota';
import { isCalendarDayAfterPaused, isScheduleTimeOfDayReached } from '../lib/localDateTime';
import { processFollowUpJobsOnce } from './followUpJobWorker.js';

// ── Configuration ──

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 20;
const MAX_CONCURRENT_CAMPAIGNS = 50;
const MAX_SMTP_PER_USER = 5;
const MIN_EMAIL_DELAY_MS = 60_000;   // 1 minute
const MAX_EMAIL_DELAY_MS = 120_000;  // 2 minutes

/** If false, scheduled campaigns never auto-activate; user must use Start. Default: on (for production). Set WORKER_AUTO_ACTIVATE_SCHEDULED=0 to disable. */
const AUTO_ACTIVATE_SCHEDULED =
  process.env.WORKER_AUTO_ACTIVATE_SCHEDULED !== '0' && process.env.WORKER_AUTO_ACTIVATE_SCHEDULED !== 'false';

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
  customFields: string | null;
  messageId: string | null;
  sentAt: string | null;
  delieveredAt: string | null;
  openedAt: string | null;
  repliedAt: string | null;
};

// ── Send one email (with tracking pixel + unsubscribe) ──

async function sendOneEmail(
  campaign: Campaign,
  recipient: RecipientRow,
  trackingBaseUrl?: string | null
): Promise<string> {
  let htmlBody = replacePlaceholders(campaign.emailContent, {
    email: recipient.email,
    name: recipient.name,
    customFields: recipient.customFields
  });
  
  const subject = replacePlaceholders(campaign.subject, {
    email: recipient.email,
    name: recipient.name,
    customFields: recipient.customFields
  });

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
    subject: subject,
    html: htmlBody,
    fromName: campaign.fromName,
    fromEmail: campaign.fromEmail,
    listUnsubscribeUrl,
    userId: campaign.userId,
    smtpSettingsId: campaign.smtpSettingsId,
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
      customFields: r.custom_fields as string | null,
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

async function pauseCampaignForQuota(
  campaignId: number,
  pauseReason: typeof PAUSE_SMTP_DAILY_LIMIT | typeof PAUSE_DAILY_CAMPAIGN_CAP,
  userId: number
): Promise<void> {
  await db
    .update(campaignTable)
    .set({
      status: 'paused',
      pauseReason,
      pausedAt: sql`now()`,
      pauseAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(campaignTable.id, campaignId));
  await db
    .update(recipientTable)
    .set({ status: 'pending' })
    .where(and(eq(recipientTable.campaignId, campaignId), eq(recipientTable.status, 'sending')));
  await insertLimitNotification(
    userId,
    pauseReason === PAUSE_SMTP_DAILY_LIMIT ? 'smtp_daily_limit' : 'daily_campaign_cap',
    { campaignId }
  );
  console.log(`[Worker] Campaign #${campaignId} paused (${pauseReason}).`);
}

async function pauseIfQuotaExceeded(campaign: typeof campaignTable.$inferSelect): Promise<boolean> {
  if (campaign.status !== 'in_progress') return false;
  const smtpId = campaign.smtpSettingsId;
  if (!smtpId) return false;
  const smtpRow = await getSmtpProfileRow(campaign.userId, smtpId);
  const smtpLimit = Number(smtpRow?.dailyEmailLimit ?? 50);
  if (smtpLimit > 0) {
    const sent = await countSendsTodayForSmtp(campaign.userId, smtpId);
    if (sent >= smtpLimit) {
      await pauseCampaignForQuota(campaign.id, PAUSE_SMTP_DAILY_LIMIT, campaign.userId);
      return true;
    }
  }
  if (campaign.dailySendLimit != null && campaign.dailySendLimit > 0) {
    const cSent = await countSendsTodayForCampaign(campaign.id);
    if (cSent >= campaign.dailySendLimit) {
      await pauseCampaignForQuota(campaign.id, PAUSE_DAILY_CAMPAIGN_CAP, campaign.userId);
      return true;
    }
  }
  return false;
}

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
    const { config } = await getOrCreateTransport(campaign.userId, campaign.smtpSettingsId);
    const messageId = await sendOneEmail(
      campaign,
      recipient,
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

    if (campaign.smtpSettingsId) {
      await recordSuccessfulSend(campaign.userId, campaign.smtpSettingsId, recipient.campaignId);
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

  if (!isScheduledTimeReached(campaignRow.scheduledAt)) {
    const scheduledDate = parseLocalTimestamp(campaignRow.scheduledAt);
    console.log(`[Worker] Campaign #${campaignId} waiting for scheduled time (${scheduledDate?.toLocaleString()}), skipping.`);
    return;
  }

  const campaign = campaignRow as Campaign;
  const smtpQueue = getUserSmtpQueue(campaign.userId);

  console.log(`[Worker] Starting campaign #${campaignId} "${campaign.name}" (user ${campaign.userId})`);

  let totalSent = 0;
  let isFirstEmail = true;
  let batchesChecked = 0;

  while (true) {
    const stillActive = await isCampaignInProgress(campaignId);
    if (!stillActive) {
      console.log(`[Worker] Campaign #${campaignId} no longer in_progress, stopping.`);
      break;
    }

    const [fresh] = await db.select().from(campaignTable).where(eq(campaignTable.id, campaignId)).limit(1);
    if (!fresh || fresh.status !== 'in_progress') break;
    if (await pauseIfQuotaExceeded(fresh)) {
      console.log(`[Worker] Campaign #${campaignId} hit daily quota, stopping.`);
      break;
    }

    const batch = await claimBatch(campaignId);
    batchesChecked++;
    if (batch.length === 0) {
      if (batchesChecked === 1) {
        console.log(`[Worker] Campaign #${campaignId} has no pending recipients — nothing to send.`);
      }
      break;
    }

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

// When `scheduled_at` is stored as local wall time (varchar) and `isScheduledTimeReached` uses the
// same clock as the app server, due campaigns are promoted to `in_progress` without a manual Start.

async function activateScheduledCampaigns(): Promise<void> {
  if (!AUTO_ACTIVATE_SCHEDULED) return;
  try {
    const candidates = await dbPool.query(
      `SELECT c.id, c.name, c.scheduled_at AS scheduled_at_local
       FROM campaigns c
       WHERE c.status = 'scheduled'
         AND c.scheduled_at IS NOT NULL
         AND c.scheduled_at::text != ''
         AND EXISTS (
           SELECT 1 FROM recipients r
           WHERE r.campaign_id = c.id AND r.status = 'pending'
         )`
    );

    const nowLocal = getCurrentLocalTimestampString();
    const dueIds: number[] = [];
    const dueNamesById = new Map<number, string>();

    for (const row of candidates.rows as Array<{ id: number; name: string; scheduled_at_local: string | null }>) {
      const scheduledAt = String(row.scheduled_at_local || '').replace('T', ' ').trim().slice(0, 19);
      if (!scheduledAt) continue;
      if (isScheduledTimeReached(scheduledAt)) {
        dueIds.push(row.id);
        dueNamesById.set(row.id, row.name);
      } else {
        console.log(`[Scheduler] Campaign #${row.id} "${row.name}" waiting — scheduled=${scheduledAt}, now=${nowLocal}`);
      }
    }

    if (dueIds.length === 0) return;

    const activated = await dbPool.query(
      `UPDATE campaigns
       SET status = 'in_progress', updated_at = NOW()
       WHERE id = ANY($1::int[]) AND status = 'scheduled'
       RETURNING id`,
      [dueIds]
    );
    for (const row of activated.rows as Array<{ id: number }>) {
      const campaignName = dueNamesById.get(row.id) || 'Unnamed';
      const source = candidates.rows.find((r: { id: number }) => Number(r.id) === Number(row.id)) as
        | { scheduled_at_local?: string }
        | undefined;
      console.log(
        `[Scheduler] Auto-started campaign #${row.id} "${campaignName}" (scheduled=${source?.scheduled_at_local ?? 'unknown'}, now=${nowLocal})`
      );
    }
  } catch (e) {
    console.error('[Scheduler] Error activating scheduled campaigns:', e);
  }
}

// ── Auto-pause campaigns whose pause_at has been reached ──
// Mirrors the manual pause endpoint: status -> 'paused' and any 'sending' recipients -> 'pending',
// so the existing Resume button continues to work.

async function autoResumeDailyPausedCampaigns(): Promise<void> {
  try {
    const candidates = await db
      .select()
      .from(campaignTable)
      .where(
        and(
          eq(campaignTable.status, 'paused'),
          or(
            eq(campaignTable.pauseReason, PAUSE_SMTP_DAILY_LIMIT),
            eq(campaignTable.pauseReason, PAUSE_DAILY_CAMPAIGN_CAP)
          )
        )
      );
    for (const c of candidates) {
      if (!c.pausedAt) continue;
      if (!isCalendarDayAfterPaused(String(c.pausedAt))) continue;
      if (!isScheduleTimeOfDayReached(c.scheduledAt)) continue;
      const pendingRow = await db
        .select({ c: count() })
        .from(recipientTable)
        .where(and(eq(recipientTable.campaignId, c.id), eq(recipientTable.status, 'pending')));
      if (Number(pendingRow[0]?.c ?? 0) === 0) continue;
      const busy = await db
        .select({ id: campaignTable.id })
        .from(campaignTable)
        .where(and(eq(campaignTable.userId, c.userId), eq(campaignTable.status, 'in_progress')))
        .limit(1);
      if (busy[0]) continue;
      await db
        .update(campaignTable)
        .set({
          status: 'in_progress',
          pauseReason: null,
          pausedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(campaignTable.id, c.id));
      console.log(`[Scheduler] Auto-resumed campaign #${c.id} after daily pause (schedule time reached)`);
    }
  } catch (e) {
    console.error('[Scheduler] autoResumeDailyPausedCampaigns:', e);
  }
}

async function autoPauseCampaigns(): Promise<void> {
  try {
    const candidates = await dbPool.query(
      `SELECT c.id, c.name, c.pause_at AS pause_at_local
       FROM campaigns c
       WHERE c.status = 'in_progress'
         AND c.pause_at IS NOT NULL
         AND c.pause_at::text != ''`
    );

    const nowLocal = getCurrentLocalTimestampString();
    const dueIds: number[] = [];
    const dueNamesById = new Map<number, string>();

    for (const row of candidates.rows as Array<{ id: number; name: string; pause_at_local: string | null }>) {
      const pauseAt = String(row.pause_at_local || '').replace('T', ' ').trim().slice(0, 19);
      if (!pauseAt) continue;
      if (isScheduledTimeReached(pauseAt)) {
        dueIds.push(row.id);
        dueNamesById.set(row.id, row.name);
      }
    }

    if (dueIds.length === 0) return;

    const paused = await dbPool.query(
      `UPDATE campaigns
       SET status = 'paused', pause_at = NULL, updated_at = NOW()
       WHERE id = ANY($1::int[]) AND status = 'in_progress'
       RETURNING id`,
      [dueIds]
    );

    if (paused.rowCount && paused.rowCount > 0) {
      const pausedIds = (paused.rows as Array<{ id: number }>).map((r) => Number(r.id));
      // Revert any in-flight rows so a future Resume can claim them again.
      await dbPool.query(
        `UPDATE recipients
         SET status = 'pending'
         WHERE campaign_id = ANY($1::int[]) AND status = 'sending'`,
        [pausedIds]
      );
      for (const id of pausedIds) {
        const campaignName = dueNamesById.get(id) || 'Unnamed';
        console.log(`[Scheduler] Auto-paused campaign #${id} "${campaignName}" at ${nowLocal}`);
      }
    }
  } catch (e) {
    console.error('[Scheduler] Error auto-pausing campaigns:', e);
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
  console.log(
    `Config: MAX_CONCURRENT_CAMPAIGNS=${MAX_CONCURRENT_CAMPAIGNS}, MAX_SMTP_PER_USER=${MAX_SMTP_PER_USER}, BATCH_SIZE=${BATCH_SIZE}, autoActivateScheduled=${AUTO_ACTIVATE_SCHEDULED}`
  );
  console.log(`Email delay: random ${MIN_EMAIL_DELAY_MS / 1000}s–${MAX_EMAIL_DELAY_MS / 1000}s between sends (per campaign, non-blocking)`);

  while (true) {
    try {
      await activateScheduledCampaigns();
      await autoPauseCampaigns();
      await autoResumeDailyPausedCampaigns();
      await processFollowUpJobsOnce();

      // Get ALL in_progress campaigns and filter in Node.js for reliable time comparison
      const inProgressResult = await dbPool.query(
        `SELECT id, scheduled_at as scheduled_at_str
         FROM campaigns
         WHERE status = 'in_progress'`
      );
      const allInProgress = inProgressResult.rows as Array<{ id: number; scheduled_at_str: string | null }>;

      for (const c of allInProgress) {
        // Skip if already being processed
        if (activeCampaigns.has(c.id)) continue;

        // Check if scheduled time has arrived using proper Date comparison
        if (!isScheduledTimeReached(c.scheduled_at_str)) {
          continue; // Not yet time, skip
        }

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
