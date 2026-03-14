import 'dotenv/config'
import { campaignTable, recipientTable, statsTable } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../lib/db';
import { getSmtpSettings } from '../lib/smtpSettings';
import { normalizeMessageId } from '../lib/messageId.js';
import { sendEmail as sendViaSmtp } from '../lib/smtp';
import type { Recipient } from '../types/reciepients';
import type { Campaign } from '../types/campaign';

const POLL_INTERVAL_MS = 1500;
const BATCH_SIZE = 10;
const SENDING_RATE = 2; // emails per second (Gmail-friendly)
let lastSendTime = Date.now();

function getTrackingBaseUrl(trackingBaseUrl?: string | null): string {
  return (trackingBaseUrl && trackingBaseUrl.trim()) || process.env.TRACKING_BASE_URL || process.env.PUBLIC_URL || 'http://localhost:3000';
}

async function sendOneEmail(
  campaign: Campaign,
  recipient: Recipient & { id: number },
  trackingBaseUrl?: string | null
): Promise<string> {
  const timeSinceLastSend = Date.now() - lastSendTime;
  const minInterval = 1000 / SENDING_RATE;
  if (timeSinceLastSend < minInterval) {
    await new Promise((resolve) => setTimeout(resolve, minInterval - timeSinceLastSend));
  }

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
  lastSendTime = Date.now();
  return messageId;
}

async function processBatch() {
  const inProgressCampaigns = await db
    .select({ id: campaignTable.id })
    .from(campaignTable)
    .where(eq(campaignTable.status, 'in_progress'));

  if (inProgressCampaigns.length === 0) {
    return 0;
  }

  const campaignIds = inProgressCampaigns.map((c) => c.id);
  const pendingRecipients = await db
    .select()
    .from(recipientTable)
    .where(
      and(eq(recipientTable.status, 'pending'), inArray(recipientTable.campaignId, campaignIds))
    )
    .limit(BATCH_SIZE);

  if (pendingRecipients.length === 0) {
    return 0;
  }

  const campaignIdsNeeded = [...new Set(pendingRecipients.map((r) => r.campaignId))];
  const campaigns = await db
    .select()
    .from(campaignTable)
    .where(inArray(campaignTable.id, campaignIdsNeeded));
  const campaignMap = new Map(campaigns.map((c) => [c.id, c as Campaign]));

  let processed = 0;
  for (const recipient of pendingRecipients) {
    const campaign = campaignMap.get(recipient.campaignId);
    if (!campaign) continue;

    try {
      const messageId = await sendOneEmail(campaign, recipient as Recipient & { id: number });

      const storedMessageId = normalizeMessageId(messageId) ?? messageId ?? undefined;
      await db
        .update(recipientTable)
        .set({
          status: 'sent',
          messageId: storedMessageId,
          sentAt: new Date().toISOString(),
        })
        .where(eq(recipientTable.id, recipient.id));

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

      console.log(`Email sent to ${recipient.email}, MessageId: ${messageId}`);
      processed++;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : '';
      console.error(`Failed to send to ${recipient.email}:`, errMsg, errStack || '');
      await db
        .update(recipientTable)
        .set({ status: 'failed' })
        .where(eq(recipientTable.id, recipient.id));

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

async function poll() {
  console.log('Worker polling database for pending emails (SMTP)...');
  console.log('SMTP host:', process.env.SMTP_HOST || '(not set)', '| User:', process.env.SMTP_USER || '(not set)');

  while (true) {
    try {
      const processed = await processBatch();
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
