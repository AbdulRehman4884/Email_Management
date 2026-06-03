import 'dotenv/config';
import PQueue from 'p-queue';
import { campaignTable, recipientTable, statsTable, campaignPersonalizedEmailsTable, recipientSequenceStateTable } from '../db/schema';
import { eq, and, inArray, or, isNotNull, count, sql } from 'drizzle-orm';
import { db, dbPool, logDbConnectionInfo, validateDbSchema } from '../lib/db';
import { normalizeMessageId } from '../lib/messageId.js';
import { sendEmail as sendViaSmtp, getOrCreateTransport } from '../lib/smtp';
import {
  classifySmtpSendFailure,
  extractSmtpErrorParts,
  truncateLastSendError,
} from '../lib/smtpSendDiagnostics.js';
import { getCurrentLocalTimestampString, isScheduledTimeReached, parseLocalTimestamp } from '../lib/localDateTime';
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
import { replacePlaceholders } from '../lib/replacePlaceholders';
import { getSmtpProfileRow } from '../lib/smtpSettings';
import {
  countSendsTodayForCampaign,
  countSendsTodayForSmtp,
  insertLimitNotification,
  interpretSmtpDailyLimit,
  PAUSE_DAILY_CAMPAIGN_CAP,
  PAUSE_SEND_WINDOW,
  PAUSE_SMTP_DAILY_LIMIT,
  PAUSE_WEEKDAY_FILTER,
  recordSuccessfulSend,
} from '../lib/dailySendQuota';
import { hasDailySendWindow, isWithinDailySendWindow } from '../lib/dailySendWindow.js';
import {
  getIsoWeekdayInScheduleZone,
  isSendWeekdayAllowed,
  parseSendWeekdaysJson,
} from '../lib/weekdaySendSchedule.js';
import { isCalendarDayAfterPaused, isScheduleTimeOfDayReached } from '../lib/localDateTime';
import { computePauseAtOnStart, scheduleStringAsVarchar } from '../lib/campaignPauseSchedule.js';
import { processFollowUpJobsOnce } from './followUpJobWorker.js';
import { decideCampaignWork, type CampaignDiagnostics } from './workerCampaignStatus.js';

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
/** Maps campaignId → epoch-ms of next due follow-up. Set by processCampaign when a campaign
 *  has no current work but future follow-ups are scheduled. The poll loop skips the campaign
 *  until this time arrives, preventing a tight 2-second busy-wait. */
const campaignNextDue = new Map<number, number>();

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

function isCampaignCoolingDown(campaignId: number, now = Date.now()): boolean {
  const nextEligiblePollAt = campaignNextDue.get(campaignId);
  if (!nextEligiblePollAt) return false;
  if (nextEligiblePollAt <= now) {
    campaignNextDue.delete(campaignId);
    return false;
  }
  return true;
}

function setCampaignCooldownUntil(campaignId: number, nextDueAt: Date): void {
  const nextEligiblePollAt = nextDueAt.getTime();
  if (!Number.isFinite(nextEligiblePollAt) || nextEligiblePollAt <= Date.now()) {
    campaignNextDue.delete(campaignId);
    return;
  }
  campaignNextDue.set(campaignId, nextEligiblePollAt);
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
  recipient: RecipientRow,
  trackingBaseUrl?: string | null,
  overrides?: {
    subject?: string | null;
    htmlBody?: string | null;
    touchId?: number;
  },
): Promise<string> {
  const { personalizedSubject, personalizedBody } = await getPersonalizedContent(campaign.id, recipient.id);
  const hasOverrideBody = typeof overrides?.htmlBody === 'string' && overrides.htmlBody.trim().length > 0;
  const tokenContext = {
    email: recipient.email,
    name: recipient.name,
    customFields: recipient.customFields,
  };
  let htmlBody = hasOverrideBody
    ? String(overrides?.htmlBody)
    : replacePlaceholders(personalizedBody ?? campaign.emailContent, tokenContext);
  const subject = replacePlaceholders(
    overrides?.subject?.trim() || personalizedSubject?.trim() || campaign.subject,
    tokenContext,
  );

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
  // Missing profile falls back to legacy default of 50; otherwise honor null/0/positive.
  const smtpLimit = interpretSmtpDailyLimit(smtpRow ? smtpRow.dailyEmailLimit : 50);
  if (smtpLimit === 'blocked') {
    // Daily limit 0 means no emails are allowed at all.
    await pauseCampaignForQuota(campaign.id, PAUSE_SMTP_DAILY_LIMIT, campaign.userId);
    return true;
  }
  if (smtpLimit !== 'unlimited') {
    const sent = await countSendsTodayForSmtp(campaign.userId, smtpId);
    if (sent >= smtpLimit.cap) {
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

async function pauseCampaignForWeekdayFilter(campaignId: number): Promise<void> {
  await db
    .update(campaignTable)
    .set({
      status: 'paused',
      pauseReason: PAUSE_WEEKDAY_FILTER,
      pausedAt: sql`now()`,
      pauseAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(campaignTable.id, campaignId));
  await db
    .update(recipientTable)
    .set({ status: 'pending' })
    .where(and(eq(recipientTable.campaignId, campaignId), eq(recipientTable.status, 'sending')));
  console.log(`[Worker] Campaign #${campaignId} paused (outside allowed send weekdays).`);
}

async function pauseIfWeekdayBlocksSend(campaign: typeof campaignTable.$inferSelect): Promise<boolean> {
  if (campaign.status !== 'in_progress') return false;
  const allowed = parseSendWeekdaysJson(campaign.sendWeekdays);
  if (isSendWeekdayAllowed(getIsoWeekdayInScheduleZone(), allowed)) return false;
  await pauseCampaignForWeekdayFilter(campaign.id);
  return true;
}

async function pauseCampaignForSendWindow(campaignId: number, userId: number): Promise<void> {
  await db
    .update(campaignTable)
    .set({
      status: 'paused',
      pauseReason: PAUSE_SEND_WINDOW,
      pausedAt: sql`now()`,
      pauseAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(campaignTable.id, campaignId));
  await db
    .update(recipientTable)
    .set({ status: 'pending' })
    .where(and(eq(recipientTable.campaignId, campaignId), eq(recipientTable.status, 'sending')));
  await insertLimitNotification(userId, 'send_window_closed', { campaignId });
  console.log(`[Worker] Campaign #${campaignId} paused (outside daily send window).`);
}

async function pauseIfOutsideSendWindow(campaign: typeof campaignTable.$inferSelect): Promise<boolean> {
  if (campaign.status !== 'in_progress') return false;
  if (!hasDailySendWindow(campaign)) return false;
  if (isWithinDailySendWindow(campaign.dailySendWindowStart, campaign.dailySendWindowEnd)) return false;
  await pauseCampaignForSendWindow(campaign.id, campaign.userId);
  return true;
}

function campaignCanAutoResumeNow(c: typeof campaignTable.$inferSelect): boolean {
  if (!isScheduleTimeOfDayReached(c.scheduledAt)) return false;
  const sendDays = parseSendWeekdaysJson(c.sendWeekdays);
  if (!isSendWeekdayAllowed(getIsoWeekdayInScheduleZone(), sendDays)) return false;
  if (hasDailySendWindow(c) && !isWithinDailySendWindow(c.dailySendWindowStart, c.dailySendWindowEnd)) {
    return false;
  }
  return true;
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
        customFields: null,
        messageId: null,
        sentAt: null,
        delieveredAt: null,
        openedAt: null,
        repliedAt: recipientState.repliedAt,
      },
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
      .set({ status: 'sent', messageId: storedMessageId, sentAt, delieveredAt: sentAt, sentTs: sentAt, lastSendError: null })
      .where(eq(recipientTable.id, recipient.id));
    await db
      .update(recipientTable)
      .set({ status: 'sent', messageId: storedMessageId, sentAt, delieveredAt: sentAt, sentTs: sentAt, lastSendError: null })
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
    const { config } = await getOrCreateTransport(campaign.userId, campaign.smtpSettingsId);
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
      recipient,
      config.trackingBaseUrl,
    );

    const storedMessageId = normalizeMessageId(messageId) ?? messageId ?? undefined;
    const sentAt = new Date().toISOString();

    await db
      .update(recipientTable)
      .set({ status: 'sent', messageId: storedMessageId, sentAt, delieveredAt: sentAt, sentTs: sentAt, lastSendError: null })
      .where(eq(recipientTable.id, recipient.id));

    await db
      .update(recipientTable)
      .set({ status: 'sent', messageId: storedMessageId, sentAt, delieveredAt: sentAt, sentTs: sentAt, lastSendError: null })
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
        .set({
          sentCount: Number(stats[0].sentCount) + 1,
          delieveredCount: Number(stats[0].delieveredCount) + 1,
        })
        .where(eq(statsTable.campaignId, recipient.campaignId));
    }

    await markInitialTouchSent({
      campaignId: recipient.campaignId,
      recipientId: recipient.id,
      messageId: storedMessageId,
    });
    if (campaign.smtpSettingsId) {
      await recordSuccessfulSend(campaign.userId, campaign.smtpSettingsId, recipient.campaignId);
    }

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

// ── Campaign diagnostic query ─────────────────────────────────────────────────
// Single round-trip: counts pending touch-1 recipients and active sequence state
// (both due-now and future follow-ups) so the worker can make a single decision.

async function queryCampaignDiagnostics(campaignId: number): Promise<CampaignDiagnostics> {
  const [recipRes, seqRes] = await Promise.all([
    dbPool.query<{ status: string; cnt: string }>(
      `SELECT status, COUNT(*) AS cnt FROM recipients WHERE campaign_id = $1 GROUP BY status`,
      [campaignId],
    ),
    dbPool.query<{ due_now: string; future_cnt: string; next_at: string | null }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE rss.sequence_status = 'active'
             AND rss.sequence_paused = false
             AND rss.next_scheduled_touch_at IS NOT NULL
             AND rss.next_scheduled_touch_at <= NOW()
         ) AS due_now,
         COUNT(*) FILTER (
           WHERE rss.sequence_status = 'active'
             AND rss.next_scheduled_touch_at IS NOT NULL
             AND rss.next_scheduled_touch_at > NOW()
         ) AS future_cnt,
         MIN(rss.next_scheduled_touch_at) FILTER (
           WHERE rss.sequence_status = 'active'
             AND rss.next_scheduled_touch_at IS NOT NULL
             AND rss.next_scheduled_touch_at > NOW()
         ) AS next_at
       FROM recipient_sequence_state rss
       WHERE rss.campaign_id = $1`,
      [campaignId],
    ),
  ]);

  const recipMap: Record<string, number> = {};
  for (const row of recipRes.rows) recipMap[row.status] = parseInt(row.cnt, 10);

  const seqRow = seqRes.rows[0];
  return {
    pendingTouch1Recipients: recipMap['pending'] ?? 0,
    sendingRecipients:       recipMap['sending'] ?? 0,
    dueFollowUpsNow:         parseInt(seqRow?.due_now   ?? '0', 10),
    futureFollowUps:         parseInt(seqRow?.future_cnt ?? '0', 10),
    nextFollowUpAt:          seqRow?.next_at ? new Date(seqRow.next_at) : null,
  };
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

  if (await pauseIfWeekdayBlocksSend(campaignRow)) {
    console.log(`[Worker] Campaign #${campaignId} not sending today (weekday filter).`);
    return;
  }

  if (await pauseIfOutsideSendWindow(campaignRow)) {
    console.log(`[Worker] Campaign #${campaignId} outside daily send window.`);
    return;
  }

  // Diagnostic: log full workload breakdown before processing begins. If there is no
  // actionable work until a future follow-up, set a cooldown so the poll loop does
  // not re-run this diagnostic every 2 seconds.
  try {
    const diag = await queryCampaignDiagnostics(campaignId);
    const decision = decideCampaignWork(diag);
    const sentCount = await dbPool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM recipients WHERE campaign_id = $1 AND status = 'sent'`,
      [campaignId],
    );
    console.log(
      `[Worker] Campaign #${campaignId} diagnostics — ` +
      `pendingTouch1=${diag.pendingTouch1Recipients} ` +
      `sending=${diag.sendingRecipients} ` +
      `sent=${parseInt(sentCount.rows[0]?.cnt ?? '0', 10)} ` +
      `dueFollowUpsNow=${diag.dueFollowUpsNow} ` +
      `futureFollowUps=${diag.futureFollowUps}` +
      (diag.nextFollowUpAt ? ` nextFollowUpAt=${diag.nextFollowUpAt.toISOString()}` : '')
    );

    if (decision.action === 'wait' && decision.nextDueAt) {
      setCampaignCooldownUntil(campaignId, decision.nextDueAt);
      console.log(`[Worker] Campaign #${campaignId} has no current work; next eligible follow-up poll at ${decision.nextDueAt.toISOString()}.`);
      return;
    }

    campaignNextDue.delete(campaignId);
    if (decision.action === 'idle') {
      return;
    }
  } catch (diagErr) {
    console.warn(`[Worker] Campaign #${campaignId} diagnostic query failed:`, diagErr);
  }

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

    const [fresh] = await db.select().from(campaignTable).where(eq(campaignTable.id, campaignId)).limit(1);
    if (!fresh || fresh.status !== 'in_progress') break;
    if (await pauseIfQuotaExceeded(fresh)) {
      console.log(`[Worker] Campaign #${campaignId} hit daily quota, stopping.`);
      break;
    }
    if (await pauseIfWeekdayBlocksSend(fresh)) {
      console.log(`[Worker] Campaign #${campaignId} paused (weekday filter).`);
      break;
    }
    if (await pauseIfOutsideSendWindow(fresh)) {
      console.log(`[Worker] Campaign #${campaignId} paused (daily send window closed).`);
      break;
    }

    const batch = await claimBatch(campaignId);
    batchesChecked++;
    const recipients = deduplicateBatch(batch);
    const followUps = batch.length === 0 ? await claimDueFollowUpBatch(campaignId, BATCH_SIZE) : [];

    if (recipients.length === 0 && followUps.length === 0) {
      if (batchesChecked === 1) {
        try {
          const diag = await queryCampaignDiagnostics(campaignId);
          const decision = decideCampaignWork(diag);
          if (decision.action === 'wait' && decision.nextDueAt) {
            setCampaignCooldownUntil(campaignId, decision.nextDueAt);
            console.log(`[Worker] Campaign #${campaignId} has no current work; next eligible follow-up poll at ${decision.nextDueAt.toISOString()}.`);
          } else {
            campaignNextDue.delete(campaignId);
            console.log(`[Worker] Campaign #${campaignId} has no pending recipients or due follow-ups.`);
          }
        } catch (diagErr) {
          console.warn(`[Worker] Campaign #${campaignId} follow-up cooldown check failed:`, diagErr);
          console.log(`[Worker] Campaign #${campaignId} has no pending recipients or due follow-ups.`);
        }
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

      // Re-check SMTP / campaign daily caps before every send. Otherwise one claimed batch could send
      // multiple emails in this inner loop after the first push pushed counts over the cap (e.g. cap 1 → 2 sends).
      const [quotaCampaign] = await db
        .select()
        .from(campaignTable)
        .where(eq(campaignTable.id, campaignId))
        .limit(1);
      if (!quotaCampaign || quotaCampaign.status !== 'in_progress') {
        await db
          .update(recipientTable)
          .set({ status: 'pending' })
          .where(
            and(
              eq(recipientTable.campaignId, campaignId),
              eq(recipientTable.status, 'sending')
            )
          );
        break;
      }
      if (await pauseIfQuotaExceeded(quotaCampaign)) {
        console.log(`[Worker] Campaign #${campaignId} hit SMTP or campaign daily limit before next send.`);
        break;
      }
      if (await pauseIfWeekdayBlocksSend(quotaCampaign)) {
        console.log(`[Worker] Campaign #${campaignId} paused (weekday filter) before next send.`);
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
      const [cRow] = await db.select().from(campaignTable).where(eq(campaignTable.id, row.id)).limit(1);
      if (!cRow) continue;
      const mergedPause = computePauseAtOnStart(
        {
          scheduledAt: cRow.scheduledAt,
          pauseAt: cRow.pauseAt,
          autoPauseAfterMinutes: cRow.autoPauseAfterMinutes ?? null,
        },
        'scheduled_activation'
      );
      await db
        .update(campaignTable)
        .set({
          pauseAt: mergedPause ? scheduleStringAsVarchar(mergedPause) : null,
          updatedAt: sql`now()`,
        })
        .where(eq(campaignTable.id, row.id));
    }
  } catch (e) {
    console.error('[Scheduler] Error activating scheduled campaigns:', e);
  }
}

// ── Auto-pause campaigns whose pause_at has been reached ──
// Mirrors the manual pause endpoint: status -> 'paused' and any 'sending' recipients -> 'pending',
// so the existing Resume button continues to work.

async function autoPauseInProgressOutsideSendWindow(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(campaignTable)
      .where(eq(campaignTable.status, 'in_progress'));
    for (const c of rows) {
      if (!hasDailySendWindow(c)) continue;
      if (isWithinDailySendWindow(c.dailySendWindowStart, c.dailySendWindowEnd)) continue;
      await pauseCampaignForSendWindow(c.id, c.userId);
    }
  } catch (e) {
    console.error('[Scheduler] autoPauseInProgressOutsideSendWindow:', e);
  }
}

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
            eq(campaignTable.pauseReason, PAUSE_DAILY_CAMPAIGN_CAP),
            eq(campaignTable.pauseReason, PAUSE_WEEKDAY_FILTER),
            eq(campaignTable.pauseReason, PAUSE_SEND_WINDOW)
          )
        )
      );
    for (const c of candidates) {
      if (!c.pausedAt) continue;
      const isWindowPause = c.pauseReason === PAUSE_SEND_WINDOW;
      if (!isWindowPause && !isCalendarDayAfterPaused(String(c.pausedAt))) continue;
      if (!campaignCanAutoResumeNow(c)) continue;
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

// ── Release stuck 'sending' rows ─────────────────────────────────────────────
//
// If the worker process crashed mid-batch (SIGTERM, OOM, unhandled rejection)
// some recipients and campaign_sequence_touches rows are left permanently in
// 'sending' status.
//
// Problem:
//   claimBatch queries  WHERE status = 'pending'          → misses them, sends 0
//   markCompletedCampaigns checks IN ('pending','sending') → sees them, won't complete
//   Result: campaign loops forever with "no pending recipients"
//
// Fix: at the top of each poll tick, reset those rows back to 'pending'.
// We only touch campaigns NOT currently in activeCampaigns to avoid racing
// with live in-progress sends.

async function releaseStuckSendingRecipients(): Promise<void> {
  try {
    const activeIds = [...activeCampaigns];
    const inProgressSubq = `campaign_id IN (SELECT id FROM campaigns WHERE status = 'in_progress')`;
    const excludeClause  = activeIds.length > 0
      ? `campaign_id NOT IN (${activeIds.map((_, i) => `$${i + 1}`).join(',')}) AND `
      : '';

    const [recipRes, touchRes] = await Promise.all([
      dbPool.query(
        `UPDATE recipients
            SET status = 'pending'
          WHERE status = 'sending'
            AND ${excludeClause}${inProgressSubq}`,
        activeIds,
      ),
      dbPool.query(
        `UPDATE campaign_sequence_touches
            SET execution_status = 'pending'
          WHERE execution_status = 'sending'
            AND ${excludeClause}${inProgressSubq}`,
        activeIds,
      ),
    ]);

    if (recipRes.rowCount && recipRes.rowCount > 0) {
      console.log(`[Worker] Recovered ${recipRes.rowCount} stuck 'sending' recipients → 'pending'.`);
    }
    if (touchRes.rowCount && touchRes.rowCount > 0) {
      console.log(`[Worker] Recovered ${touchRes.rowCount} stuck follow-up touches → 'pending'.`);
    }
  } catch (e) {
    console.error('[Worker] releaseStuckSendingRecipients error:', e);
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
      await autoPauseInProgressOutsideSendWindow();
      await autoResumeDailyPausedCampaigns();
      await processFollowUpJobsOnce();
      await releaseStuckSendingRecipients();

      // Get ALL in_progress campaigns and filter in Node.js for reliable time comparison
      const inProgressResult = await dbPool.query(
        `SELECT id, scheduled_at as scheduled_at_str
         FROM campaigns
         WHERE status = 'in_progress'`
      );
      const allInProgress = inProgressResult.rows as Array<{ id: number; scheduled_at_str: string | null }>;
      const inProgressIds = new Set(allInProgress.map((campaign) => campaign.id));
      for (const campaignId of campaignNextDue.keys()) {
        if (!inProgressIds.has(campaignId)) campaignNextDue.delete(campaignId);
      }

      if (allInProgress.length === 0) {
        // Log campaign status summary so operators can see why nothing is being sent
        try {
          const statusSummary = await dbPool.query<{ status: string; cnt: string }>(
            `SELECT status, COUNT(*) AS cnt FROM campaigns GROUP BY status ORDER BY status`
          );
          if (statusSummary.rows.length > 0) {
            const parts = statusSummary.rows.map((r) => `${r.status}=${r.cnt}`).join(' ');
            console.log(`[Worker] No in_progress campaigns — campaign status summary: ${parts}`);
          } else {
            console.log('[Worker] No campaigns found in database.');
          }
        } catch (summaryErr) {
          console.warn('[Worker] Status summary query failed:', summaryErr);
        }
      }

      for (const c of allInProgress) {
        // Skip if already being processed
        if (activeCampaigns.has(c.id)) continue;
        if (isCampaignCoolingDown(c.id)) continue;

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

async function startWorker(): Promise<void> {
  await logDbConnectionInfo('worker');
  await validateDbSchema({ throwOnError: true });
  await poll();
}

startWorker().catch((error) => {
  console.error('[Worker] Fatal startup error. Worker will exit before polling:', error);
  process.exit(1);
});
