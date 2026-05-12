import 'dotenv/config';
import PQueue from 'p-queue';
import { campaignTable, recipientTable, statsTable, campaignPersonalizedEmailsTable, recipientSequenceStateTable } from '../db/schema';
import { eq, and, inArray, or, isNotNull } from 'drizzle-orm';
import { db, dbPool } from '../lib/db';
import { normalizeMessageId } from '../lib/messageId.js';
import { sendEmail as sendViaSmtp, getOrCreateTransport } from '../lib/smtp';
import {
  classifySmtpSendFailure,
  extractSmtpErrorParts,
  truncateLastSendError,
} from '../lib/smtpSendDiagnostics.js';
import { getCurrentLocalTimestampString, isScheduledTimeReached, parseLocalTimestamp } from '../lib/localDateTime';
import type { Recipient } from '../types/reciepients';
import type { Campaign } from '../types/campaign';
import {
  checkFollowUpThrottle,
  claimDueFollowUpBatch,
  deferRecipientSequence,
  isRecipientSuppressed,
  markFollowUpTouchFailed,
  markFollowUpTouchSent,
  markInitialTouchFailed,
  markInitialTouchSent,
  releaseFollowUpClaims,
  stopRecipientSequence,
} from '../lib/sequenceExecutionEngine.js';
import { generateUnsubscribeToken } from '../lib/unsubscribeToken.js';

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
  messageId: string | null;
  sentAt: string | null;
  delieveredAt: string | null;
  openedAt: string | null;
  repliedAt: string | null;
};

// ── Send one email (with tracking pixel + unsubscribe) ──

async function getPersonalizedContent(
  campaignId: number,
  recipientId: number,
): Promise<{ personalizedSubject: string | null; personalizedBody: string | null }> {
  const [row] = await db
    .select({
      personalizedSubject: campaignPersonalizedEmailsTable.personalizedSubject,
      personalizedBody: campaignPersonalizedEmailsTable.personalizedBody,
    })
    .from(campaignPersonalizedEmailsTable)
    .where(and(
      eq(campaignPersonalizedEmailsTable.campaignId, campaignId),
      eq(campaignPersonalizedEmailsTable.recipientId, recipientId),
    ))
    .limit(1);
  return {
    personalizedSubject: row?.personalizedSubject ?? null,
    personalizedBody: row?.personalizedBody ?? null,
  };
}

async function sendOneEmail(
  campaign: Campaign,
  recipient: Recipient & { id: number },
  trackingBaseUrl?: string | null,
  overrides?: {
    subject?: string | null;
    htmlBody?: string | null;
    touchId?: number;
  },
): Promise<string> {
  const { personalizedSubject, personalizedBody } = await getPersonalizedContent(campaign.id, recipient.id);
  const hasOverrideBody = typeof overrides?.htmlBody === 'string' && overrides.htmlBody.trim().length > 0;
  let htmlBody = hasOverrideBody ? String(overrides?.htmlBody) : (personalizedBody ?? campaign.emailContent);
  const subject = overrides?.subject?.trim() || personalizedSubject?.trim() || campaign.subject;
  if (!hasOverrideBody && !personalizedBody) {
    htmlBody = htmlBody
      .replace(/{{firstName}}/g, recipient.name?.split(' ')[0] || '')
      .replace(/{{email}}/g, recipient.email);
  }

  const baseUrl = getTrackingBaseUrl(trackingBaseUrl);
  const trackingUrl = `${baseUrl}/api/track/open?r=${recipient.id}${overrides?.touchId ? `&touch=${overrides.touchId}` : ''}`;
  const trackingPixel = `<img src="${trackingUrl}" width="1" height="1" alt="" style="display:none" />`;
  if (htmlBody.includes('</body>')) {
    htmlBody = htmlBody.replace('</body>', `${trackingPixel}</body>`);
  } else {
    htmlBody = htmlBody + trackingPixel;
  }

  const unsubscribeBaseUrl =
    process.env.UNSUBSCRIBE_BASE_URL ||
    process.env.TRACKING_BASE_URL ||
    process.env.PUBLIC_URL ||
    trackingBaseUrl;
  const unsubscribeToken = generateUnsubscribeToken({
    campaignId: campaign.id,
    recipientId: recipient.id,
    email: recipient.email,
  });
  const listUnsubscribeUrl = unsubscribeBaseUrl
    ? `${unsubscribeBaseUrl.replace(/\/$/, '')}/unsubscribe/${unsubscribeToken}`
    : undefined;

  const messageId = await sendViaSmtp({
    to: recipient.email,
    subject,
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

async function getRecipientGuardState(recipientId: number): Promise<{
  status: string;
  repliedAt: Date | null;
  email: string;
} | null> {
  const [row] = await db
    .select({
      status: recipientTable.status,
      repliedAt: recipientTable.repliedAt,
      email: recipientTable.email,
    })
    .from(recipientTable)
    .where(eq(recipientTable.id, recipientId))
    .limit(1);
  return row ?? null;
}

async function sendFollowUpTouch(
  touch: Awaited<ReturnType<typeof claimDueFollowUpBatch>>[number],
  campaign: Campaign,
): Promise<boolean> {
  const canSend = await isCampaignInProgress(touch.campaignId);
  if (!canSend) {
    await deferRecipientSequence({
      campaignId: touch.campaignId,
      recipientId: touch.recipientId,
      touchNumber: touch.touchNumber,
      retryAt: new Date(Date.now() + 10 * 60 * 1000),
      reason: 'campaign_not_in_progress',
    });
    return false;
  }

  const recipientState = await getRecipientGuardState(touch.recipientId);
  if (!recipientState) {
    await stopRecipientSequence({
      campaignId: touch.campaignId,
      recipientId: touch.recipientId,
      sequenceStatus: 'stopped',
      stopReason: 'error_limit',
    });
    return false;
  }

  if (recipientState.repliedAt) {
    await stopRecipientSequence({
      campaignId: touch.campaignId,
      recipientId: touch.recipientId,
      sequenceStatus: 'replied',
      stopReason: 'replied',
    });
    return false;
  }

  if (recipientState.status === 'bounced' || recipientState.status === 'complained') {
    await stopRecipientSequence({
      campaignId: touch.campaignId,
      recipientId: touch.recipientId,
      sequenceStatus: 'bounced',
      stopReason: 'bounced',
    });
    return false;
  }

  if (await isRecipientSuppressed(touch.email)) {
    await stopRecipientSequence({
      campaignId: touch.campaignId,
      recipientId: touch.recipientId,
      sequenceStatus: 'unsubscribed',
      stopReason: 'unsubscribed',
    });
    return false;
  }

  const throttle = await checkFollowUpThrottle(touch.email);
  if (!throttle.allowed && throttle.retryAt) {
    await deferRecipientSequence({
      campaignId: touch.campaignId,
      recipientId: touch.recipientId,
      touchNumber: touch.touchNumber,
      retryAt: throttle.retryAt,
      reason: throttle.reason ?? 'follow_up_throttled',
    });
    return false;
  }

  let smtpHostForLog = '';
  let smtpPortForLog = 0;
  let smtpUserForLog = '';
  try {
    const { config } = await getOrCreateTransport(campaign.userId);
    smtpHostForLog = String(config.host ?? '');
    smtpPortForLog = Number(config.port) || 0;
    smtpUserForLog = String(config.user ?? '');
    const messageId = await sendOneEmail(
      campaign,
      {
        id: touch.recipientId,
        campaignId: touch.campaignId,
        email: touch.email,
        status: recipientState.status,
        name: touch.name,
        messageId: null,
        sentAt: null,
        delieveredAt: null,
        openedAt: null,
        repliedAt: recipientState.repliedAt,
      } as Recipient & { id: number },
      config.trackingBaseUrl,
      {
        subject: touch.personalizedSubject,
        htmlBody: touch.personalizedBody,
        touchId: touch.touchId,
      },
    );
    const storedMessageId = normalizeMessageId(messageId) ?? messageId ?? undefined;
    await markFollowUpTouchSent({
      campaignId: touch.campaignId,
      recipientId: touch.recipientId,
      touchNumber: touch.touchNumber,
      messageId: storedMessageId,
    });
    console.log(`[Worker/Campaign${touch.campaignId}] Sent follow-up touch ${touch.touchNumber} to ${touch.email}, MessageId: ${messageId}`);
    return true;
  } catch (error: unknown) {
    const parts = extractSmtpErrorParts(error);
    const classified = classifySmtpSendFailure(error, {
      smtpHost: smtpHostForLog,
      smtpPort: smtpPortForLog,
      smtpUser: smtpUserForLog,
      campaignFromEmail: String(campaign.fromEmail ?? ''),
    });
    const storedError = truncateLastSendError(
      `[${classified.category}] ${classified.detailForRecipient}`,
    );
    await markFollowUpTouchFailed({
      campaignId: touch.campaignId,
      recipientId: touch.recipientId,
      touchNumber: touch.touchNumber,
      errorCategory: classified.category,
      errorMessage: storedError,
    });
    console.error(
      `[Worker/FollowUp] campaignId=${touch.campaignId} touch=${touch.touchNumber} to=${touch.email} host=${smtpHostForLog || 'n/a'} port=${smtpPortForLog || 'n/a'} smtpUser=${smtpUserForLog || 'n/a'} ` +
      `errCode=${parts.code ?? 'n/a'} responseCode=${parts.responseCode ?? 'n/a'} message=${parts.message}`,
    );
    return false;
  }
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

  if (recipient.repliedAt) {
    await stopRecipientSequence({
      campaignId: recipient.campaignId,
      recipientId: recipient.id,
      sequenceStatus: 'replied',
      stopReason: 'replied',
    });
    await db
      .update(recipientTable)
      .set({ status: 'sent' })
      .where(eq(recipientTable.id, recipient.id));
    return false;
  }

  if (await isRecipientSuppressed(recipient.email)) {
    await stopRecipientSequence({
      campaignId: recipient.campaignId,
      recipientId: recipient.id,
      sequenceStatus: 'unsubscribed',
      stopReason: 'unsubscribed',
    });
    await db
      .update(recipientTable)
      .set({ status: 'failed', lastSendError: '[unsubscribed] Recipient is on suppression list.' })
      .where(eq(recipientTable.id, recipient.id));
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
      .set({ status: 'sent', messageId: storedMessageId, sentAt, lastSendError: null })
      .where(eq(recipientTable.id, recipient.id));
    await db
      .update(recipientTable)
      .set({ status: 'sent', messageId: storedMessageId, sentAt, lastSendError: null })
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

  let smtpHostForLog = '';
  let smtpPortForLog = 0;
  let smtpUserForLog = '';
  try {
    const { config } = await getOrCreateTransport(campaign.userId);
    smtpHostForLog = String(config.host ?? '');
    smtpPortForLog = Number(config.port) || 0;
    smtpUserForLog = String(config.user ?? '');
    const host = smtpHostForLog.trim();
    const smtpUser = smtpUserForLog.trim();
    const smtpPass = String(config.pass ?? '').trim();
    if (!host) {
      throw new Error('SMTP host is not configured for this user.');
    }
    if (!smtpUser || !smtpPass) {
      throw new Error(
        'SMTP username or password is empty. Configure SMTP in Settings (same user as the campaign), or set SMTP_USER and SMTP_PASS in the backend environment.',
      );
    }

    const messageId = await sendOneEmail(
      campaign,
      recipient as Recipient & { id: number },
      config.trackingBaseUrl,
    );

    const storedMessageId = normalizeMessageId(messageId) ?? messageId ?? undefined;
    const sentAt = new Date().toISOString();

    await db
      .update(recipientTable)
      .set({ status: 'sent', messageId: storedMessageId, sentAt, lastSendError: null })
      .where(eq(recipientTable.id, recipient.id));

    await db
      .update(recipientTable)
      .set({ status: 'sent', messageId: storedMessageId, sentAt, lastSendError: null })
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

    await markInitialTouchSent({
      campaignId: recipient.campaignId,
      recipientId: recipient.id,
      messageId: storedMessageId,
    });

    console.log(`[Worker/Campaign${recipient.campaignId}] Sent to ${recipient.email}, MessageId: ${messageId}`);
    return true;
  } catch (error: unknown) {
    const errStack = error instanceof Error ? error.stack : '';
    const parts = extractSmtpErrorParts(error);
    const classified = classifySmtpSendFailure(error, {
      smtpHost: smtpHostForLog,
      smtpPort: smtpPortForLog,
      smtpUser: smtpUserForLog,
      campaignFromEmail: String(campaign.fromEmail ?? ''),
    });
    const storedError = truncateLastSendError(
      `[${classified.category}] ${classified.detailForRecipient}`,
    );

    console.error(
      `[Worker/SMTP] campaignId=${recipient.campaignId} to=${recipient.email} host=${smtpHostForLog || 'n/a'} port=${smtpPortForLog || 'n/a'} smtpUser=${smtpUserForLog || 'n/a'} ` +
        `errCode=${parts.code ?? 'n/a'} responseCode=${parts.responseCode ?? 'n/a'} message=${parts.message}`,
    );
    console.error('[Worker][send failed]', {
      campaignId: recipient.campaignId,
      recipientId: recipient.id,
      to: recipient.email,
      category: classified.category,
      lastSendError: storedError,
      errCode: parts.code ?? null,
      responseCode: parts.responseCode ?? null,
    });
    console.error(`[Worker/Campaign${recipient.campaignId}] ${classified.summary}`, errStack || '');

    try {
      await db
        .update(recipientTable)
        .set({ status: 'failed', lastSendError: storedError })
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
    } catch (updateError: unknown) {
      console.error('[Worker][send failed][db update failed]', {
        campaignId: recipient.campaignId,
        recipientId: recipient.id,
        to: recipient.email,
        category: classified.category,
        lastSendError: storedError,
        message: updateError instanceof Error ? updateError.message : String(updateError),
      });
    }

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
    await markInitialTouchFailed({
      campaignId: recipient.campaignId,
      recipientId: recipient.id,
      errorMessage: storedError,
    });
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
  let totalFollowUpsSent = 0;
  let isFirstEmail = true;
  let batchesChecked = 0;

  while (true) {
    const stillActive = await isCampaignInProgress(campaignId);
    if (!stillActive) {
      console.log(`[Worker] Campaign #${campaignId} no longer in_progress, stopping.`);
      break;
    }

    const batch = await claimBatch(campaignId);
    batchesChecked++;
    const recipients = deduplicateBatch(batch);
    const followUps = batch.length === 0 ? await claimDueFollowUpBatch(campaignId, BATCH_SIZE) : [];

    if (recipients.length === 0 && followUps.length === 0) {
      if (batchesChecked === 1) {
        console.log(`[Worker] Campaign #${campaignId} has no pending recipients or due follow-ups.`);
      }
      break;
    }

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
        await releaseFollowUpClaims(campaignId);
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

    for (const touch of followUps) {
      const stillRunning = await isCampaignInProgress(campaignId);
      if (!stillRunning) {
        await releaseFollowUpClaims(campaignId);
        console.log(`[Worker] Campaign #${campaignId} paused/cancelled mid-follow-up batch, released pending follow-ups.`);
        break;
      }

      if (!isFirstEmail) {
        const delay = getRandomDelay();
        console.log(`[Worker/Campaign${campaignId}] Waiting ${Math.round(delay / 1000)}s before next follow-up...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const sent = await smtpQueue.add(() => sendFollowUpTouch(touch, campaign));
      if (sent) {
        totalFollowUpsSent++;
        isFirstEmail = false;
      }
    }
  }

  console.log(`[Worker] Campaign #${campaignId} finished processing. Touch1 sent: ${totalSent}, follow-ups sent: ${totalFollowUpsSent}`);
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
         )
         AND NOT EXISTS (
           SELECT 1 FROM recipient_sequence_state rss
           WHERE rss.campaign_id = c.id AND rss.sequence_status IN ('pending', 'active')
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
