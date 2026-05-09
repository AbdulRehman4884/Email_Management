import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { and, count, eq, gte, isNull, lt } from "drizzle-orm";
import { emailSendLogTable, userNotificationsTable } from "../db/schema";
import { db } from "./db";
import { getScheduleTimeZone } from "./localDateTime";

export const PAUSE_SMTP_DAILY_LIMIT = "smtp_daily_limit" as const;
export const PAUSE_DAILY_CAMPAIGN_CAP = "daily_campaign_cap" as const;
/** Campaign paused while a scheduled bulk follow-up job runs (not auto-resumed next day). */
export const PAUSE_FOLLOW_UP_HOLD = "follow_up_hold" as const;

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
