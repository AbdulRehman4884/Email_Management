import type { Request, Response } from 'express';
import { recipientTable, statsTable } from '../db/schema';
import { db } from '../lib/db';
import { eq } from 'drizzle-orm';

/** Ignore opens within this window after primary send (prefetch/scanners often hit the pixel immediately). Keep short so real opens still record if the client caches the first load. */
const OPEN_DEBOUNCE_MS = 10_000;

function applyTrackingPixelHeaders(res: Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

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
    applyTrackingPixelHeaders(res);
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
        delieveredAt: recipientTable.delieveredAt,
      })
      .from(recipientTable)
      .where(eq(recipientTable.id, recipientId))
      .limit(1);

    if (recipients.length === 0) {
      applyTrackingPixelHeaders(res);
      res.type('gif').send(TRACKING_PIXEL);
      return;
    }

    const row = recipients[0];
    if (!row) {
      applyTrackingPixelHeaders(res);
      res.type('gif').send(TRACKING_PIXEL);
      return;
    }

    const alreadyOpened = row.openedAt != null;
    const alreadyDelivered = row.delieveredAt != null;

    if (!alreadyOpened || !alreadyDelivered) {
      const now = new Date();
      if (shouldDeferOpenUntilAfterSend(row.sentAt, now)) {
        applyTrackingPixelHeaders(res);
        res.type('gif').send(TRACKING_PIXEL);
        return;
      }
      const updates: { openedAt?: Date; status?: string; delieveredAt?: string } = {};
      if (!alreadyOpened) updates.openedAt = now;
      if (!alreadyDelivered) {
        updates.status = 'delivered';
        updates.delieveredAt = now.toISOString();
      }
      await db
        .update(recipientTable)
        .set(updates)
        .where(eq(recipientTable.id, recipientId));

      if (!alreadyOpened) {
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

  applyTrackingPixelHeaders(res);
  res.type('gif').send(TRACKING_PIXEL);
}
