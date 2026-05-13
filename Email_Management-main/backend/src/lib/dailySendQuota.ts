import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { and, count, eq, gte, isNull, lt, ne } from "drizzle-orm";
import { campaignTable, emailSendLogTable, followUpJobsTable, userNotificationsTable } from "../db/schema";
import { db } from "./db";
import { getScheduleTimeZone } from "./localDateTime";

export const PAUSE_SMTP_DAILY_LIMIT = "smtp_daily_limit" as const;
export const PAUSE_DAILY_CAMPAIGN_CAP = "daily_campaign_cap" as const;
/** Campaign paused while a scheduled bulk follow-up job runs (not auto-resumed next day). */
export const PAUSE_FOLLOW_UP_HOLD = "follow_up_hold" as const;
/** Sends only on selected weekdays; paused outside those days (auto-resume like daily cap). */
export const PAUSE_WEEKDAY_FILTER = "weekday_filter" as const;

export function getScheduleDayUtcBounds(reference: Date = new Date()): { startUtc: Date; endUtc: Date } {
  const tz = getScheduleTimeZone();
  const dayStr = formatInTimeZone(reference, tz, "yyyy-MM-dd");
  const parts = dayStr.split("-").map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const wall = new Date(y, m - 1, d, 0, 0, 0, 0);
  const startUtc = fromZonedTime(wall, tz);
  const endUtc = addDays(startUtc, 1);
  return { startUtc, endUtc };
}

export async function countSendsTodayForSmtp(userId: number, smtpSettingsId: number): Promise<number> {
  const { startUtc, endUtc } = getScheduleDayUtcBounds();
  const r = await db
    .select({ c: count() })
    .from(emailSendLogTable)
    .where(
      and(
        eq(emailSendLogTable.userId, userId),
        eq(emailSendLogTable.smtpSettingsId, smtpSettingsId),
        gte(emailSendLogTable.sentAt, startUtc),
        lt(emailSendLogTable.sentAt, endUtc)
      )
    );
  return Number(r[0]?.c ?? 0);
}

export async function countSendsTodayForCampaign(campaignId: number): Promise<number> {
  const { startUtc, endUtc } = getScheduleDayUtcBounds();
  const r = await db
    .select({ c: count() })
    .from(emailSendLogTable)
    .where(
      and(
        eq(emailSendLogTable.campaignId, campaignId),
        gte(emailSendLogTable.sentAt, startUtc),
        lt(emailSendLogTable.sentAt, endUtc)
      )
    );
  return Number(r[0]?.c ?? 0);
}

export async function recordSuccessfulSend(
  userId: number,
  smtpSettingsId: number,
  campaignId: number
): Promise<void> {
  await db.insert(emailSendLogTable).values({
    userId,
    smtpSettingsId,
    campaignId,
  });
}

/** dailyEmailLimit 0 = unlimited */
export function remainingSmtpQuota(dailyEmailLimit: number, sentToday: number): number | null {
  if (dailyEmailLimit <= 0) return null;
  return Math.max(0, dailyEmailLimit - sentToday);
}

export async function insertLimitNotification(
  userId: number,
  kind: "smtp_daily_limit" | "daily_campaign_cap",
  payload: Record<string, unknown>
): Promise<void> {
  await db.insert(userNotificationsTable).values({
    userId,
    type: kind,
    payload,
    readAt: null,
  });
}

export async function countUnreadNotifications(userId: number): Promise<number> {
  const r = await db
    .select({ c: count() })
    .from(userNotificationsTable)
    .where(and(eq(userNotificationsTable.userId, userId), isNull(userNotificationsTable.readAt)));
  return Number(r[0]?.c ?? 0);
}

/**
 * Check if an SMTP account is currently in use by any running campaign or follow-up job.
 * Used to enforce the rule: one SMTP = only one campaign/follow-up at a time.
 * @param excludeCampaignId Optional campaign ID to exclude from the check (for the current operation)
 */
export async function isSmtpInUse(
  smtpSettingsId: number,
  excludeCampaignId?: number
): Promise<{ inUse: boolean; reason?: string; campaignId?: number; campaignName?: string }> {
  // Check for running campaigns using this SMTP
  const runningCampaignWhere = excludeCampaignId
    ? and(
        eq(campaignTable.smtpSettingsId, smtpSettingsId),
        eq(campaignTable.status, "in_progress"),
        ne(campaignTable.id, excludeCampaignId)
      )
    : and(
        eq(campaignTable.smtpSettingsId, smtpSettingsId),
        eq(campaignTable.status, "in_progress")
      );

  const [runningCampaign] = await db
    .select({ id: campaignTable.id, name: campaignTable.name })
    .from(campaignTable)
    .where(runningCampaignWhere)
    .limit(1);

  if (runningCampaign) {
    return {
      inUse: true,
      reason: "campaign",
      campaignId: runningCampaign.id,
      campaignName: runningCampaign.name,
    };
  }

  // Check for running follow-up jobs using campaigns with this SMTP
  const followUpJobWhere = excludeCampaignId
    ? and(
        eq(campaignTable.smtpSettingsId, smtpSettingsId),
        eq(followUpJobsTable.status, "running"),
        ne(followUpJobsTable.campaignId, excludeCampaignId)
      )
    : and(
        eq(campaignTable.smtpSettingsId, smtpSettingsId),
        eq(followUpJobsTable.status, "running")
      );

  const [runningFollowUp] = await db
    .select({
      id: followUpJobsTable.id,
      campaignId: followUpJobsTable.campaignId,
      campaignName: campaignTable.name,
    })
    .from(followUpJobsTable)
    .innerJoin(campaignTable, eq(followUpJobsTable.campaignId, campaignTable.id))
    .where(followUpJobWhere)
    .limit(1);

  if (runningFollowUp) {
    return {
      inUse: true,
      reason: "follow_up_job",
      campaignId: runningFollowUp.campaignId,
      campaignName: runningFollowUp.campaignName,
    };
  }

  return { inUse: false };
}
