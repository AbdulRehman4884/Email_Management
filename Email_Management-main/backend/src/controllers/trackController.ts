import type { Request, Response } from 'express';
import { recipientTable, statsTable } from '../db/schema';
import { db } from '../lib/db';
import { eq } from 'drizzle-orm';

/** Ignore opens within this window after primary send (prefetch/scanners often hit the pixel immediately). */
const OPEN_DEBOUNCE_MS = 90_000;

function shouldDeferOpenUntilAfterSend(sentAt: unknown, now: Date): boolean {
  if (sentAt == null) return false;
  const t = sentAt instanceof Date ? sentAt : new Date(String(sentAt));
  if (Number.isNaN(t.getTime())) return false;
  return now.getTime() - t.getTime() < OPEN_DEBOUNCE_MS;
}

// 1x1 transparent GIF
const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

export async function trackOpenHandler(req: Request, res: Response) {
  const recipientId = req.query.r ? Number(req.query.r) : NaN;
  if (!Number.isInteger(recipientId) || recipientId < 1) {
    res.setHeader('Cache-Control', 'no-store');
    res.type('gif').send(TRACKING_PIXEL);
    return;
  }

  try {
    const recipients = await db
      .select({
        id: recipientTable.id,
        campaignId: recipientTable.campaignId,
        openedAt: recipientTable.openedAt,
        sentAt: recipientTable.sentAt,
      })
      .from(recipientTable)
      .where(eq(recipientTable.id, recipientId))
      .limit(1);

    if (recipients.length === 0) {
      res.setHeader('Cache-Control', 'no-store');
      res.type('gif').send(TRACKING_PIXEL);
      return;
    }

    const row = recipients[0];
    if (!row) {
      res.setHeader('Cache-Control', 'no-store');
      res.type('gif').send(TRACKING_PIXEL);
      return;
    }

    const alreadyOpened = row.openedAt != null;

    if (!alreadyOpened) {
      const now = new Date();
      if (!shouldDeferOpenUntilAfterSend(row.sentAt, now)) {
        await db.update(recipientTable).set({ openedAt: now }).where(eq(recipientTable.id, recipientId));

        const stats = await db
          .select({ openedCount: statsTable.openedCount })
          .from(statsTable)
          .where(eq(statsTable.campaignId, row.campaignId))
          .limit(1);
        if (stats[0]) {
          await db
            .update(statsTable)
            .set({ openedCount: Number(stats[0].openedCount) + 1 })
            .where(eq(statsTable.campaignId, row.campaignId));
        }
      }
    }
  } catch (_) {
    // still return pixel
  }

  res.setHeader('Cache-Control', 'no-store');
  res.type('gif').send(TRACKING_PIXEL);
}
