import type { Request, Response } from 'express';
import { recipientTable, statsTable } from '../db/schema';
import { db } from '../lib/db';
import { eq } from 'drizzle-orm';

function applyTrackingPixelHeaders(res: Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/**
 * Automated fetchers that hit the tracking pixel WITHOUT a human opening the email:
 * link/security scanners, spam filters, link-preview bots, monitoring tools and raw HTTP
 * libraries. These must NOT be counted as an "open" — an open should only register when a
 * real mail client renders the pixel (whenever that happens, even days/weeks later).
 *
 * Note: Gmail's image proxy ("GoogleImageProxy") is intentionally NOT in this list — Gmail
 * fetches the image when the user actually opens the message, so it represents a real open.
 */
const NON_HUMAN_UA_PATTERNS: RegExp[] = [
  /bot\b/i,
  /\bcrawl/i,
  /spider/i,
  /\bpreview\b/i,
  /scanner/i,
  /\bscan\b/i,
  /monitor/i,
  /uptime/i,
  /validator/i,
  /fetcher/i,
  /facebookexternalhit/i,
  /slackbot/i,
  /telegrambot/i,
  /whatsapp/i,
  /discordbot/i,
  /bingpreview/i,
  /skypeuripreview/i,
  /proofpoint/i,
  /barracuda/i,
  /mimecast/i,
  /symantec/i,
  /forcepoint/i,
  /python-requests/i,
  /curl\//i,
  /\bwget\b/i,
  /go-http-client/i,
  /okhttp/i,
  /java\//i,
  /libwww/i,
  /httpclient/i,
  /apache-httpclient/i,
  /headlesschrome/i,
  /phantomjs/i,
  /axios/i,
  /node-fetch/i,
  /\bperl\b/i,
  /\bruby\b/i,
];

/**
 * Returns true when the request looks like an automated fetch (no human open).
 * A genuine open comes from a real mail client / browser with a normal browser-like UA.
 */
function isNonHumanOpen(userAgent: string | undefined): boolean {
  const ua = (userAgent ?? '').trim();
  // Empty UA almost always means a scanner / bot / raw HTTP client.
  if (!ua) return true;
  // Real mail clients and browsers send a "Mozilla/..." style UA. Anything that doesn't
  // is overwhelmingly an automated client.
  if (!/mozilla|applewebkit|gecko|webkit/i.test(ua)) return true;
  return NON_HUMAN_UA_PATTERNS.some((re) => re.test(ua));
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
    // Only count the pixel load when it comes from a real mail client, not an automated
    // scanner/proxy that fetches images before any human opens the email.
    if (isNonHumanOpen(req.headers['user-agent'])) {
      applyTrackingPixelHeaders(res);
      res.type('gif').send(TRACKING_PIXEL);
      return;
    }

    const recipients = await db
      .select({
        id: recipientTable.id,
        campaignId: recipientTable.campaignId,
        openedAt: recipientTable.openedAt,
      })
      .from(recipientTable)
      .where(eq(recipientTable.id, recipientId))
      .limit(1);

    const row = recipients[0];
    if (!row) {
      applyTrackingPixelHeaders(res);
      res.type('gif').send(TRACKING_PIXEL);
      return;
    }

    const alreadyOpened = row.openedAt != null;
    if (!alreadyOpened) {
      // Record the real open time (whenever it happens).
      await db.update(recipientTable).set({ openedAt: new Date() }).where(eq(recipientTable.id, recipientId));

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

  applyTrackingPixelHeaders(res);
  res.type('gif').send(TRACKING_PIXEL);
}
