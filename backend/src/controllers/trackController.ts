import type { Request, Response } from 'express';
import { recipientTable, statsTable } from '../db/schema';
import { db } from '../lib/db';
import { eq } from 'drizzle-orm';

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
        delieveredAt: recipientTable.delieveredAt,
      })
      .from(recipientTable)
      .where(eq(recipientTable.id, recipientId))
      .limit(1);

    if (recipients.length === 0) {
      res.setHeader('Cache-Control', 'no-store');
      res.type('gif').send(TRACKING_PIXEL);
      return;
    }

    const [row] = recipients;
    const alreadyOpened = row.openedAt != null;
    const alreadyDelivered = row.delieveredAt != null;
    const now = new Date();

    if (!alreadyOpened || !alreadyDelivered) {
      const updates: { openedAt?: Date; status?: string; delieveredAt?: Date } = {};
      if (!alreadyOpened) updates.openedAt = now;
      if (!alreadyDelivered) {
        updates.status = 'delivered';
        updates.delieveredAt = now;
      }
      await db
        .update(recipientTable)
        .set(updates)
        .where(eq(recipientTable.id, recipientId));

      const stats = await db
        .select({ openedCount: statsTable.openedCount, delieveredCount: statsTable.delieveredCount })
        .from(statsTable)
        .where(eq(statsTable.campaignId, row.campaignId))
        .limit(1);
      if (stats[0]) {
        const statUpdates: { openedCount?: number; delieveredCount?: number } = {};
        if (!alreadyOpened) statUpdates.openedCount = Number(stats[0].openedCount) + 1;
        if (!alreadyDelivered) statUpdates.delieveredCount = Number(stats[0].delieveredCount) + 1;
        if (Object.keys(statUpdates).length > 0) {
          await db
            .update(statsTable)
            .set(statUpdates)
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
