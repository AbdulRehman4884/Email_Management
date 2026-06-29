import type { Request, Response } from 'express';
import { recipientTable, statsTable } from '../db/schema';
import { db } from '../lib/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

function applyTrackingPixelHeaders(res: Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/**
 * Mail providers (e.g. Gmail) and security scanners often fetch the tracking pixel the instant
 * an email is sent/delivered — with a browser-like User-Agent that looks just like a real open.
 * A hit this close to the send time is NOT a human open (the email was only just delivered), so
 * we ignore pixel loads that arrive within this window after the precise send time (`sent_ts`).
 *
 * This does NOT affect genuine opens: a person reading the email minutes, hours, days or even a
 * month later is far outside this window and is always counted. Override with
 * OPEN_TRACKING_DEBOUNCE_MS (set 0 to disable entirely).
 */
const OPEN_DEBOUNCE_MS = (() => {
  const raw = Number(process.env.OPEN_TRACKING_DEBOUNCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
})();

function isWithinDebounceOf(anchor: unknown, now: Date): boolean {
  if (anchor == null) return false;
  const t = anchor instanceof Date ? anchor : new Date(String(anchor));
  if (Number.isNaN(t.getTime())) return false;
  const delta = now.getTime() - t.getTime();
  // Negative delta (anchor in the future) also indicates an automated/clock-skewed fetch.
  return delta < OPEN_DEBOUNCE_MS;
}

/**
 * Mailbox providers and privacy proxies (notably Apple Mail Privacy Protection) prefetch the
 * tracking pixel as soon as the message is received — with a browser-like User-Agent. A hit this
 * close to the send time OR the delivery time is the provider caching the image, not a human open,
 * so it is ignored. Genuine opens that happen minutes/hours/days later are always counted.
 *
 * `delivered_at` is currently a date-only column, so this mainly adds coverage via the precise
 * `sent_ts`; keying off delivery too keeps the guard correct if delivery ever carries a time.
 */
function isImmediatePostSendHit(sentTs: unknown, deliveredAt: unknown, now: Date): boolean {
  if (OPEN_DEBOUNCE_MS <= 0) return false;
  return isWithinDebounceOf(sentTs, now) || isWithinDebounceOf(deliveredAt, now);
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
  // Yahoo Mail prefetches images through its proxy on receipt (analogous to a privacy proxy),
  // so these hits are not human opens. Gmail's GoogleImageProxy is intentionally NOT listed
  // (it fetches when the user actually opens the message — see note above).
  /yahoomailproxy/i,
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
        sentTs: recipientTable.sentTs,
        delieveredAt: recipientTable.delieveredAt,
        status: recipientTable.status,
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
    if (['failed', 'bounced', 'complained'].includes(String(row.status || '').toLowerCase())) {
      applyTrackingPixelHeaders(res);
      res.type('gif').send(TRACKING_PIXEL);
      return;
    }

    const now = new Date();
    const alreadyOpened = row.openedAt != null;
    if (!alreadyOpened && !isImmediatePostSendHit(row.sentTs, row.delieveredAt, now)) {
      // Record the first open atomically: the `opened_at IS NULL` guard means two near-simultaneous
      // pixel hits can never both set the timestamp, so we only increment the cached counter once.
      const updated = await db
        .update(recipientTable)
        .set({ openedAt: now })
        .where(and(eq(recipientTable.id, recipientId), isNull(recipientTable.openedAt)))
        .returning({ id: recipientTable.id });

      if (updated.length > 0) {
        await db
          .update(statsTable)
          .set({ openedCount: sql`${statsTable.openedCount} + 1` })
          .where(eq(statsTable.campaignId, row.campaignId));
      }
    }
  } catch (_) {
    // still return pixel
  }

  applyTrackingPixelHeaders(res);
  res.type('gif').send(TRACKING_PIXEL);
}
