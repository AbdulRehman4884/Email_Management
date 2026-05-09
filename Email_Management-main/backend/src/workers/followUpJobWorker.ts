import { and, asc, eq, sql } from "drizzle-orm";
import { campaignTable, followUpJobsTable, recipientTable } from "../db/schema";
import { db } from "../lib/db";
import {
  countSendsTodayForCampaign,
  countSendsTodayForSmtp,
  insertLimitNotification,
  PAUSE_SMTP_DAILY_LIMIT,
  PAUSE_DAILY_CAMPAIGN_CAP,
  PAUSE_FOLLOW_UP_HOLD,
} from "../lib/dailySendQuota";
import { getSmtpProfileRow } from "../lib/smtpSettings";
import { isScheduledTimeReached } from "../lib/localDateTime";
import { sendFollowUpOutbound } from "../lib/sendFollowUp";
import { eligibleRecipientsWhere, type FollowUpEngagement } from "../lib/followUpFilters";

const MIN_DELAY_MS = 60_000;
const MAX_DELAY_MS = 120_000;

function randomDelay(): number {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pauseCampaignForFollowUpHold(campaignId: number): Promise<void> {
  await db
    .update(campaignTable)
    .set({
      status: "paused",
      pauseReason: PAUSE_FOLLOW_UP_HOLD,
      pausedAt: sql`now()`,
      pauseAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(campaignTable.id, campaignId));
  await db
    .update(recipientTable)
    .set({ status: "pending" })
    .where(and(eq(recipientTable.campaignId, campaignId), eq(recipientTable.status, "sending")));
}

async function pauseCampaignForCampaignDailyCap(campaignId: number, userId: number): Promise<void> {
  await db
    .update(campaignTable)
    .set({
      status: "paused",
      pauseReason: PAUSE_DAILY_CAMPAIGN_CAP,
      pausedAt: sql`now()`,
      pauseAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(campaignTable.id, campaignId));
  await db
    .update(recipientTable)
    .set({ status: "pending" })
    .where(and(eq(recipientTable.campaignId, campaignId), eq(recipientTable.status, "sending")));
  await insertLimitNotification(userId, "daily_campaign_cap", { campaignId });
}

async function pauseCampaignForSmtpDailyLimit(campaignId: number, userId: number): Promise<void> {
  await db
    .update(campaignTable)
    .set({
      status: "paused",
      pauseReason: PAUSE_SMTP_DAILY_LIMIT,
      pausedAt: sql`now()`,
      pauseAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(campaignTable.id, campaignId));
  await db
    .update(recipientTable)
    .set({ status: "pending" })
    .where(and(eq(recipientTable.campaignId, campaignId), eq(recipientTable.status, "sending")));
  await insertLimitNotification(userId, "smtp_daily_limit", { campaignId });
}

async function assertSmtpQuotaAllowsSend(
  userId: number,
  smtpSettingsId: number | null | undefined
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!smtpSettingsId) {
    return { ok: false, message: "Campaign has no SMTP profile selected." };
  }
  const smtpRow = await getSmtpProfileRow(userId, smtpSettingsId);
  if (!smtpRow) {
    return { ok: false, message: "SMTP profile not found." };
  }
  const limit = Number(smtpRow.dailyEmailLimit ?? 50);
  if (limit <= 0) return { ok: true };
  const sent = await countSendsTodayForSmtp(userId, smtpSettingsId);
  if (sent >= limit) {
    return {
      ok: false,
      message:
        "Daily send limit reached for this SMTP profile. Edit the campaign or wait until tomorrow.",
    };
  }
  return { ok: true };
}

function parseEngagement(raw: string | null | undefined): FollowUpEngagement | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "sent" || s === "opened" || s === "delivered") return s;
  return null;
}

async function failJob(jobId: number, message: string): Promise<void> {
  await db
    .update(followUpJobsTable)
    .set({
      status: "failed",
      errorMessage: message.slice(0, 2000),
      completedAt: sql`now()`,
    })
    .where(eq(followUpJobsTable.id, jobId));
}

async function completeJobRunDurationReached(jobId: number): Promise<void> {
  await db
    .update(followUpJobsTable)
    .set({
      status: "completed",
      completedAt: sql`now()`,
      errorMessage: "Maximum run duration reached; remaining recipients were not emailed.",
    })
    .where(eq(followUpJobsTable.id, jobId));
}

async function runFollowUpJob(job: typeof followUpJobsTable.$inferSelect): Promise<void> {
  const userId = job.userId;
  const [campaign] = await db.select().from(campaignTable).where(eq(campaignTable.id, job.campaignId)).limit(1);
  if (!campaign) {
    await failJob(job.id, "Campaign not found or deleted");
    return;
  }

  const engagement = parseEngagement(job.engagement);
  if (!engagement) {
    await failJob(job.id, "Invalid engagement on job row");
    return;
  }

  if (campaign.status === "in_progress") {
    await pauseCampaignForFollowUpHold(job.campaignId);
    await db
      .update(followUpJobsTable)
      .set({ pausedCampaignWasRunning: true })
      .where(eq(followUpJobsTable.id, job.id));
  }

  const templates = campaign.followUpTemplates ?? [];
  const tpl = templates.find((t) => t.id === job.templateId);
  if (!tpl) {
    await failJob(job.id, "Follow-up template was removed from the campaign");
    return;
  }

  const recipientRows = await db
    .select({ id: recipientTable.id })
    .from(recipientTable)
    .innerJoin(campaignTable, eq(recipientTable.campaignId, campaignTable.id))
    .where(eligibleRecipientsWhere(userId, job.campaignId, job.priorFollowUpCount, engagement))
    .orderBy(asc(recipientTable.id));

  let anchorMs = Date.now();
  if (job.startedAt) {
    const t = new Date(job.startedAt).getTime();
    if (Number.isFinite(t)) anchorMs = t;
  }
  const maxRun = job.maxRunMinutes;
  const runCapMs = maxRun != null && maxRun > 0 ? maxRun * 60_000 : null;
  const isRunCapExceeded = (): boolean =>
    runCapMs != null && Date.now() >= anchorMs + runCapMs;

  for (let i = 0; i < recipientRows.length; i++) {
    if (isRunCapExceeded()) {
      await completeJobRunDurationReached(job.id);
      return;
    }
    const r = recipientRows[i]!;
    if (i > 0) {
      await sleep(randomDelay());
      if (isRunCapExceeded()) {
        await completeJobRunDurationReached(job.id);
        return;
      }
    }

    const quota = await assertSmtpQuotaAllowsSend(userId, campaign.smtpSettingsId ?? undefined);
    if (!quota.ok) {
      await pauseCampaignForSmtpDailyLimit(job.campaignId, userId);
      await failJob(job.id, quota.message);
      return;
    }

    const campaignDaily = campaign.dailySendLimit;
    if (campaignDaily != null && campaignDaily > 0) {
      const sentToday = await countSendsTodayForCampaign(job.campaignId);
      if (sentToday >= campaignDaily) {
        await pauseCampaignForCampaignDailyCap(job.campaignId, userId);
        await failJob(job.id, "This campaign's daily send limit was reached for today.");
        return;
      }
    }

    if (isRunCapExceeded()) {
      await completeJobRunDurationReached(job.id);
      return;
    }

    const result = await sendFollowUpOutbound({
      userId,
      campaignId: job.campaignId,
      recipientId: r.id,
      subject: tpl.subject,
      body: tpl.body,
      followUpTemplateId: tpl.id,
      recordQuota: true,
    });

    if (!result.ok) {
      console.error(`[FollowUpJob ${job.id}] recipient ${r.id}: ${result.error}`);
    }
  }

  await db
    .update(followUpJobsTable)
    .set({
      status: "completed",
      completedAt: sql`now()`,
      errorMessage: null,
    })
    .where(eq(followUpJobsTable.id, job.id));
}

/**
 * Pick due pending jobs, claim one per campaign (no concurrent jobs per campaign), run synchronously.
 * Called from the email worker poll loop.
 */
export async function processFollowUpJobsOnce(): Promise<void> {
  const pending = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.status, "pending"));

  const due = pending
    .filter((j) => isScheduledTimeReached(j.scheduledAt))
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)) || a.id - b.id);

  for (const job of due) {
    const runningSame = await db
      .select({ id: followUpJobsTable.id })
      .from(followUpJobsTable)
      .where(and(eq(followUpJobsTable.campaignId, job.campaignId), eq(followUpJobsTable.status, "running")))
      .limit(1);
    if (runningSame[0]) continue;

    const claimed = await db
      .update(followUpJobsTable)
      .set({ status: "running", startedAt: sql`now()` })
      .where(and(eq(followUpJobsTable.id, job.id), eq(followUpJobsTable.status, "pending")))
      .returning();

    if (!claimed[0]) continue;

    try {
      await runFollowUpJob(claimed[0]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[FollowUpJob ${claimed[0].id}] fatal:`, e);
      await failJob(claimed[0].id, msg || "Job failed");
    }
  }
}
