import type { Request, Response } from 'express';
import { desc, eq, and, isNull, sql } from 'drizzle-orm';
import { userNotificationsTable } from '../db/schema';
import { db } from '../lib/db';
import { countSendsTodayForSmtp, smtpQuotaForProfile } from '../lib/dailySendQuota';
import { listSmtpProfilesForUser } from '../lib/smtpSettings';

/** Same zone rule as lib/db.ts (DB_TIMEZONE / PGTZ, default Asia/Karachi): the zone created_at is written in. */
function dbTimeZone(): string {
  const raw = (process.env.DB_TIMEZONE || process.env.PGTZ || 'Asia/Karachi').trim();
  return /^[A-Za-z0-9_/+:.-]+$/.test(raw) ? raw : 'Asia/Karachi';
}

export async function getNotificationsHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = await db
      .select({
        id: userNotificationsTable.id,
        userId: userNotificationsTable.userId,
        type: userNotificationsTable.type,
        payload: userNotificationsTable.payload,
        readAt: userNotificationsTable.readAt,
        createdAt: userNotificationsTable.createdAt,
        // created_at has no time zone (it is in the DB session zone). This is the real moment in UTC,
        // so the bell can show "5m ago" correctly (CRM step 6).
        createdAtIso: sql<string>`to_char((${userNotificationsTable.createdAt} AT TIME ZONE ${dbTimeZone()}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      })
      .from(userNotificationsTable)
      .where(eq(userNotificationsTable.userId, userId))
      .orderBy(desc(userNotificationsTable.createdAt))
      .limit(50);
    // Count all unread rows (not only the 50 shown), so the bell number is right.
    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(userNotificationsTable)
      .where(and(eq(userNotificationsTable.userId, userId), isNull(userNotificationsTable.readAt)));
    const unread = counted?.n ?? rows.filter((r) => r.readAt == null).length;
    res.status(200).json({ notifications: rows, unreadCount: unread });
  } catch (e) {
    console.error('getNotificationsHandler', e);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
}

export async function postNotificationsReadAllHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    await db
      .update(userNotificationsTable)
      .set({ readAt: sql`now()` })
      .where(and(eq(userNotificationsTable.userId, userId), isNull(userNotificationsTable.readAt)));
    res.status(200).json({ message: 'Marked as read' });
  } catch (e) {
    console.error('postNotificationsReadAllHandler', e);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
}

/** Marks one notification as read (CRM step 6: clicking it in the bell). */
export async function postNotificationReadHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid notification id' });
    const updated = await db
      .update(userNotificationsTable)
      .set({ readAt: sql`now()` })
      .where(and(eq(userNotificationsTable.id, id), eq(userNotificationsTable.userId, userId), isNull(userNotificationsTable.readAt)))
      .returning({ id: userNotificationsTable.id });
    res.status(200).json({ ok: true, updated: updated.length });
  } catch (e) {
    console.error('postNotificationReadHandler', e);
    res.status(500).json({ error: 'Failed to update the notification' });
  }
}

export async function getSmtpQuotaSummaryHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const profiles = await listSmtpProfilesForUser(userId);
    // Same rules as the email worker (interpretSmtpDailyLimit): at most SMTP_DAILY_EMAIL_LIMIT_MAX (20)
    // per account per day, an empty limit means 20, and 0 means sending is off for this account.
    const profilesOut = await Promise.all(
      profiles.map(async (p) => {
        const sentToday = await countSendsTodayForSmtp(userId, p.id);
        const { dailyLimit, remaining, blocked } = smtpQuotaForProfile(p.dailyEmailLimit, sentToday);
        return {
          smtpSettingsId: p.id,
          fromEmail: p.fromEmail,
          dailyLimit,
          sentToday,
          remaining,
          blocked,
        };
      })
    );
    res.status(200).json({ profiles: profilesOut });
  } catch (e) {
    console.error('getSmtpQuotaSummaryHandler', e);
    res.status(500).json({ error: 'Failed to load SMTP quota summary' });
  }
}
