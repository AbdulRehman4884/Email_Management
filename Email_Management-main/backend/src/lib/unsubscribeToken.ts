/**
 * Signed unsubscribe links (bug E2E-02).
 *
 * The link used to be /api/unsubscribe?email=<address>, so anyone who knew an address could
 * unsubscribe that person (and the CRM moved the lead to Lost). Now every email gets
 *   /api/unsubscribe?r=<recipient id>&t=<token>
 * where the token is an HMAC of the recipient id and address with a server secret. Only the person
 * who received that email has the token.
 *
 * Secret: UNSUBSCRIBE_SECRET, else JWT_SECRET (already set for logins). Changing it makes the links
 * in emails that were already sent invalid, so keep it stable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

function secret(): string | null {
  const s = (process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || '').trim();
  return s.length > 0 ? s : null;
}

function sign(recipientId: number, email: string, key: string): string {
  return createHmac('sha256', key)
    .update(`unsubscribe:${recipientId}:${email.trim().toLowerCase()}`)
    .digest('base64url')
    .slice(0, 32);
}

/** Token for one recipient row, or null when no secret is configured. */
export function unsubscribeToken(recipientId: number, email: string): string | null {
  const key = secret();
  return key ? sign(recipientId, email, key) : null;
}

/** True when `token` was made for this recipient id and address. Constant-time compare. */
export function verifyUnsubscribeToken(recipientId: number, email: string, token: unknown): boolean {
  const key = secret();
  if (!key || typeof token !== 'string' || token.length !== 32) return false;
  const expected = Buffer.from(sign(recipientId, email, key));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The link for the List-Unsubscribe header. Without a secret it falls back to the old email-only
 * link (with a warning), so sending never breaks.
 */
export function buildUnsubscribeUrl(baseUrl: string, recipientId: number, email: string): string {
  const base = `${baseUrl.replace(/\/$/, '')}/api/unsubscribe`;
  const token = unsubscribeToken(recipientId, email);
  if (!token) {
    warnNoSecretOnce();
    return `${base}?email=${encodeURIComponent(email)}`;
  }
  return `${base}?r=${recipientId}&t=${token}`;
}

let warned = false;
function warnNoSecretOnce() {
  if (warned) return;
  warned = true;
  console.warn('[unsubscribe] UNSUBSCRIBE_SECRET / JWT_SECRET is not set: unsubscribe links are sent without a token.');
}
