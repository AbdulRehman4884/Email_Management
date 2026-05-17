import type { Request, Response } from 'express';
import { desc, eq, and, isNull, sql } from 'drizzle-orm';
import { userNotificationsTable } from '../db/schema';
import { db } from '../lib/db';
import { countSendsTodayForSmtp } from '../lib/dailySendQuota';
import { listSmtpProfilesForUser } from '../lib/smtpSettings';

export async function getNotificationsHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = await db
      .select()
      .from(userNotificationsTable)
      .where(eq(userNotificationsTable.userId, userId))
      .orderBy(desc(userNotificationsTable.createdAt))
      .limit(50);
    const unread = rows.filter((r) => r.readAt == null).length;
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

export async function getSmtpQuotaSummaryHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const profiles = await listSmtpProfilesForUser(userId);
    const profilesOut = await Promise.all(
      profiles.map(async (p) => {
        const limit = Number(p.dailyEmailLimit ?? 50);
        const sentToday = await countSendsTodayForSmtp(userId, p.id);
        const remaining = limit <= 0 ? null : Math.max(0, limit - sentToday);
        return {
          smtpSettingsId: p.id,
          fromEmail: p.fromEmail,
          dailyLimit: limit,
          sentToday,
          remaining,
        };
      })
    );
    res.status(200).json({ profiles: profilesOut });
  } catch (e) {
    console.error('getSmtpQuotaSummaryHandler', e);
    res.status(500).json({ error: 'Failed to load SMTP quota summary' });
  }
}
