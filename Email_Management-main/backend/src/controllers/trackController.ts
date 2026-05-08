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

    // Opens only: never infer "delivered" from the pixel (same request used to set both,
    // so scanners/prefetches counted as opens whenever mail became "delivered").
    // Recipient delivery timestamps + delivered stats come from SMTP webhooks (e.g. SES), not tracking GIFs.
    if (!alreadyOpened) {
      const now = new Date();
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
  } catch (_) {
    // still return pixel
  }

  res.setHeader('Cache-Control', 'no-store');
  res.type('gif').send(TRACKING_PIXEL);
}
