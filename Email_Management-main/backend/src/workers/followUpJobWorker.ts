import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { campaignTable, followUpJobsTable, recipientTable } from "../db/schema";
import { db } from "../lib/db";
import {
  countSendsTodayForCampaign,
  countSendsTodayForSmtp,
  insertLimitNotification,
  interpretSmtpDailyLimit,
  isSmtpInUse,
  PAUSE_SMTP_DAILY_LIMIT,
  PAUSE_DAILY_CAMPAIGN_CAP,
  PAUSE_FOLLOW_UP_HOLD,
  FOLLOW_UP_PAUSE_MSG_SMTP_DAILY,
  FOLLOW_UP_PAUSE_MSG_CAMPAIGN_DAILY,
  isDailyQuotaPauseMessage,
} from "../lib/dailySendQuota";
import { getSmtpProfileRow } from "../lib/smtpSettings";
import { isCalendarDayAfterPaused, isScheduledTimeReached } from "../lib/localDateTime";
import {
  getIsoWeekdayInScheduleZone,
  isSendWeekdayAllowed,
  parseSendWeekdaysJson,
} from "../lib/weekdaySendSchedule.js";
import { sendFollowUpOutbound } from "../lib/sendFollowUp";
import { eligibleRecipientsWhere, type FollowUpEngagement } from "../lib/followUpFilters";

const MIN_DELAY_MS = 60_000;
const MAX_DELAY_MS = 120_000;
/** When a worker dies mid-job, treat `running` longer than this as interrupted (no maxRunMinutes). */
const STALE_RUNNING_DEFAULT_MS = 35 * 60_000;

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
): Promise<{ ok: true } | { ok: false; message: string; retryable: boolean }> {
  if (!smtpSettingsId) {
    return { ok: false, message: "Campaign has no SMTP profile selected.", retryable: false };
  }
  const smtpRow = await getSmtpProfileRow(userId, smtpSettingsId);
  if (!smtpRow) {
    return { ok: false, message: "SMTP profile not found.", retryable: false };
  }
  const limit = interpretSmtpDailyLimit(smtpRow.dailyEmailLimit);
  if (limit === "unlimited") return { ok: true };
  if (limit === "blocked") {
    return {
      ok: false,
      retryable: false,
      message:
        "This SMTP profile's daily limit is 0 (no emails allowed). Set a daily limit in Settings to send.",
    };
  }
  const sent = await countSendsTodayForSmtp(userId, smtpSettingsId);
  if (sent >= limit.cap) {
    return {
      ok: false,
      retryable: true,
      message: FOLLOW_UP_PAUSE_MSG_SMTP_DAILY,
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

/**
 * Pause a follow-up job when a daily sending limit (SMTP or campaign) is reached.
 * Unlike `failJob`, this leaves the job in a `paused` state that auto-resumes on the
 * next available sending window (see `autoResumePausedFollowUpJobs`).
 */
async function pauseJobForQuota(jobId: number, message: string): Promise<void> {
  await db
    .update(followUpJobsTable)
    .set({
      status: "paused",
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

async function isJobStillRunning(jobId: number): Promise<boolean> {
  const [row] = await db
    .select({ status: followUpJobsTable.status })
    .from(followUpJobsTable)
    .where(eq(followUpJobsTable.id, jobId))
    .limit(1);
  return row?.status === "running";
}

async function runFollowUpJob(job: typeof followUpJobsTable.$inferSelect): Promise<void> {
  const userId = job.userId;
  const [campaign] = await db.select().from(campaignTable).where(eq(campaignTable.id, job.campaignId)).limit(1);
  if (!campaign) {
    await failJob(job.id, "Campaign not found or deleted");
    return;
  }

  // Check if SMTP is already in use by another campaign or follow-up
  if (campaign.smtpSettingsId) {
    const smtpCheck = await isSmtpInUse(campaign.smtpSettingsId, job.campaignId);
    if (smtpCheck.inUse) {
      const reasonMsg = smtpCheck.reason === "follow_up_job"
        ? `SMTP is running another follow-up job for campaign "${smtpCheck.campaignName}"`
        : `SMTP is running campaign "${smtpCheck.campaignName}"`;
      await failJob(job.id, `${reasonMsg}. Wait for it to complete or use a different SMTP.`);
      return;
    }
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

  const allowedSendDays = parseSendWeekdaysJson(job.sendWeekdays);

  for (let i = 0; i < recipientRows.length; i++) {
    // Check if job was stopped/cancelled before processing each recipient
    if (!(await isJobStillRunning(job.id))) {
      console.log(`[FollowUpJob ${job.id}] Job was stopped or cancelled, exiting.`);
      return;
    }

    if (isRunCapExceeded()) {
      await completeJobRunDurationReached(job.id);
      return;
    }
    while (!isSendWeekdayAllowed(getIsoWeekdayInScheduleZone(), allowedSendDays)) {
      await sleep(60_000);
      if (isRunCapExceeded()) {
        await completeJobRunDurationReached(job.id);
        return;
      }
      if (!(await isJobStillRunning(job.id))) {
        console.log(`[FollowUpJob ${job.id}] Job was stopped or cancelled during weekday wait, exiting.`);
        return;
      }
    }
    const r = recipientRows[i]!;
    if (i > 0) {
      await sleep(randomDelay());
      if (isRunCapExceeded()) {
        await completeJobRunDurationReached(job.id);
        return;
      }
      // Check again after delay
      if (!(await isJobStillRunning(job.id))) {
        console.log(`[FollowUpJob ${job.id}] Job was stopped or cancelled after delay, exiting.`);
        return;
      }
    }

    const quota = await assertSmtpQuotaAllowsSend(userId, campaign.smtpSettingsId ?? undefined);
    if (!quota.ok) {
      if (quota.retryable) {
        await pauseCampaignForSmtpDailyLimit(job.campaignId, userId);
        await pauseJobForQuota(job.id, quota.message);
      } else {
        await failJob(job.id, quota.message);
      }
      return;
    }

    const campaignDaily = campaign.dailySendLimit;
    if (campaignDaily != null && campaignDaily > 0) {
      const sentToday = await countSendsTodayForCampaign(job.campaignId);
      if (sentToday >= campaignDaily) {
        await pauseCampaignForCampaignDailyCap(job.campaignId, userId);
        await pauseJobForQuota(job.id, FOLLOW_UP_PAUSE_MSG_CAMPAIGN_DAILY);
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
      followUpJobId: job.id,
      recordQuota: true,
    });

    if (!result.ok) {
      console.error(`[FollowUpJob ${job.id}] recipient ${r.id}: ${result.error}`);
      if (isDailyQuotaPauseMessage(result.error)) {
        await pauseCampaignForSmtpDailyLimit(job.campaignId, userId);
        await pauseJobForQuota(job.id, FOLLOW_UP_PAUSE_MSG_SMTP_DAILY);
        return;
      }
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
 * Auto-resume follow-up jobs that were paused due to daily limits.
 * Also recovers legacy rows still marked `failed` with a daily-limit message.
 * Resumes at the start of the next calendar day (not gated on original schedule time-of-day).
 */
async function autoResumePausedFollowUpJobs(): Promise<void> {
  try {
    const candidates = await db
      .select({
        job: followUpJobsTable,
        smtpSettingsId: campaignTable.smtpSettingsId,
      })
      .from(followUpJobsTable)
      .innerJoin(campaignTable, eq(followUpJobsTable.campaignId, campaignTable.id))
      .where(
        or(
          eq(followUpJobsTable.status, "paused"),
          and(
            eq(followUpJobsTable.status, "failed"),
            or(
              ilike(followUpJobsTable.errorMessage, "%daily%limit%"),
              ilike(followUpJobsTable.errorMessage, "%smtp profile%"),
              ilike(followUpJobsTable.errorMessage, "%paused - waiting%"),
              ilike(followUpJobsTable.errorMessage, "%paused — waiting%")
            )
          )
        )
      );

    for (const { job, smtpSettingsId } of candidates) {
      if (job.status === "paused" && !isDailyQuotaPauseMessage(job.errorMessage)) continue;
      if (job.status === "failed" && !isDailyQuotaPauseMessage(job.errorMessage)) continue;

      const pausedAt = job.completedAt ?? job.startedAt;
      if (!pausedAt) continue;
      if (!isCalendarDayAfterPaused(String(pausedAt))) continue;

      const sendDays = parseSendWeekdaysJson(job.sendWeekdays);
      if (!isSendWeekdayAllowed(getIsoWeekdayInScheduleZone(), sendDays)) continue;

      if (smtpSettingsId) {
        const smtpRow = await getSmtpProfileRow(job.userId, smtpSettingsId);
        if (smtpRow) {
          const limit = interpretSmtpDailyLimit(smtpRow.dailyEmailLimit);
          if (limit === "blocked") continue;
          if (limit !== "unlimited") {
            const sent = await countSendsTodayForSmtp(job.userId, smtpSettingsId);
            if (sent >= limit.cap) continue;
          }
        }

        const smtpCheck = await isSmtpInUse(smtpSettingsId, job.campaignId);
        if (smtpCheck.inUse) continue;
      }

      const [campaign] = await db
        .select({ dailySendLimit: campaignTable.dailySendLimit })
        .from(campaignTable)
        .where(eq(campaignTable.id, job.campaignId))
        .limit(1);

      if (campaign?.dailySendLimit != null && campaign.dailySendLimit > 0) {
        const sentToday = await countSendsTodayForCampaign(job.campaignId);
        if (sentToday >= campaign.dailySendLimit) continue;
      }

      await db
        .update(followUpJobsTable)
        .set({
          status: "pending",
          errorMessage: null,
          completedAt: null,
        })
        .where(eq(followUpJobsTable.id, job.id));

      console.log(`[FollowUpJob] Auto-resumed job #${job.id} after daily limit reset`);
    }
  } catch (e) {
    console.error("[FollowUpJob] autoResumePausedFollowUpJobs error:", e);
  }
}

/** If a worker died mid-run, move stale `running` jobs back to a quota-pause state for auto-resume. */
async function recoverStaleRunningFollowUpJobs(): Promise<void> {
  try {
    const running = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.status, "running"));
    const now = Date.now();
    for (const job of running) {
      const startedMs = job.startedAt ? new Date(job.startedAt).getTime() : NaN;
      const maxRunMs =
        job.maxRunMinutes != null && job.maxRunMinutes > 0
          ? job.maxRunMinutes * 60_000
          : STALE_RUNNING_DEFAULT_MS;
      const stale = !Number.isFinite(startedMs) || now - startedMs > maxRunMs + 5 * 60_000;
      if (!stale) continue;
      await pauseJobForQuota(job.id, FOLLOW_UP_PAUSE_MSG_SMTP_DAILY);
      console.log(`[FollowUpJob] Recovered stale running job #${job.id} to paused (worker interrupted)`);
    }
  } catch (e) {
    console.error("[FollowUpJob] recoverStaleRunningFollowUpJobs error:", e);
  }
}

/**
 * Pick due pending jobs, claim one per campaign (no concurrent jobs per campaign), run synchronously.
 * Called from the email worker poll loop.
 */
export async function processFollowUpJobsOnce(): Promise<void> {
  await recoverStaleRunningFollowUpJobs();
  await autoResumePausedFollowUpJobs();

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
