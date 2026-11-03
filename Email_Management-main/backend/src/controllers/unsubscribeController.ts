import type { Request, Response } from 'express';
import { suppressionListTable } from '../db/schema';
import { db, dbPool } from '../lib/db';
import { emitForRecipient } from '../lib/crm/emit.js';
import { verifyUnsubscribeToken } from '../lib/unsubscribeToken.js';

/**
 * GET/POST /api/unsubscribe (bug E2E-02).
 *
 * New links: ?r=<recipient id>&t=<signed token> (lib/unsubscribeToken.ts).
 *   GET  shows a page with an "Unsubscribe" button (link checkers in mail systems open links
 *        on their own, so a GET never unsubscribes anybody).
 *   POST unsubscribes: the button on that page, and the one-click button of Gmail / Outlook
 *        (List-Unsubscribe-Post sends a POST to the same link). Only then does the CRM get the
 *        "unsubscribed" event, and only for the user whose campaign sent that email.
 * Old links from emails sent before this fix: ?email=<address> (no token).
 *   GET  shows the same page; POST adds the address to the suppression list so no more campaign
 *        emails go there, but the CRM lead is NOT changed (anyone can make such a link).
 *   Set UNSUBSCRIBE_LEGACY_LINKS=off to refuse old links completely.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="font-family:sans-serif;max-width:480px;margin:2rem auto;padding:1rem;color:#111827;">
  <h1 style="font-size:1.5rem;">${esc(title)}</h1>
  ${body}
</body>
</html>`;
}

const UNSUBSCRIBED_HTML = page(
  "You're unsubscribed",
  '<p>You have been removed from our mailing list and will not receive further campaign emails.</p>'
);

const INVALID_HTML = page(
  'This link is not valid',
  '<p>This unsubscribe link is not valid or has been changed. Please use the link from the email you received, or reply to that email and ask to be removed.</p>'
);

/** "a***@example.com" so the page does not show the full address. */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return email;
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
}

function confirmHtml(email: string, hidden: Record<string, string>): string {
  const fields = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return page(
    'Unsubscribe',
    `<p>Stop receiving campaign emails at <b>${esc(maskEmail(email))}</b>?</p>
  <form method="post">${fields}
    <button type="submit" style="font-size:1rem;padding:.6rem 1.2rem;border-radius:8px;border:none;background:#111827;color:#fff;cursor:pointer;">Unsubscribe</button>
  </form>`
  );
}

const pick = (req: Request, key: string): string | null => {
  const v = (req.body as Record<string, unknown> | undefined)?.[key] ?? req.query[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

function legacyLinksAllowed(): boolean {
  return (process.env.UNSUBSCRIBE_LEGACY_LINKS || '').trim().toLowerCase() !== 'off';
}

async function suppress(email: string) {
  try {
    await db.insert(suppressionListTable).values({ email, reason: 'unsubscribe' });
  } catch {
    // already in the list (unique email): nothing to do
  }
}

function send(res: Response, status: number, html: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(html);
}

export async function unsubscribeHandler(req: Request, res: Response) {
  const isPost = req.method === 'POST';
  try {
    const r = pick(req, 'r');
    const t = pick(req, 't');

    // ── signed link ──
    if (r || t) {
      const recipientId = Number(r);
      if (!Number.isInteger(recipientId) || recipientId < 1 || !t) return send(res, 400, INVALID_HTML);
      const row = await dbPool.query<{ email: string; campaign_id: number }>(
        'SELECT email, campaign_id FROM recipients WHERE id = $1',
        [recipientId]
      );
      const rec = row.rows[0];
      const email = rec?.email?.trim().toLowerCase();
      if (!rec || !email || !verifyUnsubscribeToken(recipientId, email, t)) return send(res, 400, INVALID_HTML);
      if (!isPost) return send(res, 200, confirmHtml(email, { r: String(recipientId), t }));
      await suppress(email);
      emitForRecipient(recipientId, 'unsubscribed', { campaignId: rec.campaign_id });
      return send(res, 200, UNSUBSCRIBED_HTML);
    }

    // ── old email-only link ──
    const raw = pick(req, 'email');
    const email = raw && raw.includes('@') && raw.length <= 255 ? raw.toLowerCase() : null;
    if (!email || !legacyLinksAllowed()) return send(res, 400, INVALID_HTML);
    if (!isPost) return send(res, 200, confirmHtml(email, { email }));
    // No CRM event: this link has no proof that the person asking is the one who got the email.
    await suppress(email);
    return send(res, 200, UNSUBSCRIBED_HTML);
  } catch (err) {
    console.error('unsubscribeHandler', err);
    return send(res, 500, page('Something went wrong', '<p>Please try again in a minute.</p>'));
  }
}
