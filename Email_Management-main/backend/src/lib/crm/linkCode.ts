/**
 * Signed lead codes for email links (step 10).
 *
 * Links to the user's own websites (Settings > Website tracking) get ?mf=<code> when a campaign
 * email or follow-up is sent. Links to any other website are not changed and nothing is redirected
 * through MailFlow. t.js reads the code and sends it with the page view.
 *
 * Code: "<recipient id, base 36>.<HMAC>" signed with TRACKING_SECRET, else JWT_SECRET. A guessed,
 * changed or made-up code fails the check and the visit is saved as anonymous.
 * Changing the secret makes the codes in emails that were already sent invalid, so keep it stable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dbPool } from '../db.js';
import { hostMatchesDomain, webTablesReady } from './webTracking.js';

const SIG_LENGTH = 22;
const DOMAIN_CACHE_MS = 60_000;

function secret(): string | null {
  const s = (process.env.TRACKING_SECRET || process.env.JWT_SECRET || '').trim();
  return s.length > 0 ? s : null;
}

function sign(recipientId: number, key: string): string {
  return createHmac('sha256', key).update(`mf:${recipientId}`).digest('base64url').slice(0, SIG_LENGTH);
}

/** Code for one recipient row, or null when no secret is configured. */
export function leadLinkCode(recipientId: number): string | null {
  const key = secret();
  return key ? `${recipientId.toString(36)}.${sign(recipientId, key)}` : null;
}

/** Recipient id of a valid code, else null. Constant-time compare. */
export function verifyLeadLinkCode(code: unknown): number | null {
  const key = secret();
  if (!key || typeof code !== 'string' || code.length > 40) return null;
  const m = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]+)$/.exec(code);
  if (!m) return null;
  const recipientId = parseInt(m[1]!, 36);
  if (!Number.isSafeInteger(recipientId) || recipientId < 1) return null;
  const expected = Buffer.from(sign(recipientId, key));
  const given = Buffer.from(m[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given) ? recipientId : null;
}

const domainCache = new Map<number, { domains: string[]; at: number }>();

async function siteDomains(userId: number): Promise<string[]> {
  const hit = domainCache.get(userId);
  if (hit && Date.now() - hit.at < DOMAIN_CACHE_MS) return hit.domains;
  const res = await dbPool.query<{ domain: string }>(
    `SELECT domain FROM crm_sites WHERE user_id = $1 AND is_active`,
    [userId]
  );
  const domains = res.rows.map((r) => r.domain);
  domainCache.set(userId, { domains, at: Date.now() });
  return domains;
}

/** Adds mf=<code> to one URL when it points to one of `domains`; other URLs are returned unchanged. */
function addCode(url: string, domains: string[], code: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  if (!domains.some((d) => hostMatchesDomain(host, d))) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  if (/[?&]mf=/.test(base)) return url;
  return `${base}${base.includes('?') ? '&' : '?'}mf=${code}${hash}`;
}

async function prepare(userId: number, recipientId: number): Promise<{ domains: string[]; code: string } | null> {
  const code = leadLinkCode(recipientId);
  if (!code || !(await webTablesReady())) return null;
  const domains = await siteDomains(userId);
  return domains.length > 0 ? { domains, code } : null;
}

/** Campaign HTML: adds the code to href="..." links of the user's websites. Never throws. */
export async function addLeadCodeToHtml(userId: number, recipientId: number, html: string): Promise<string> {
  try {
    const p = await prepare(userId, recipientId);
    if (!p) return html;
    return html.replace(/(\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (_m, attr: string, q: string, raw: string) => {
      const url = raw.replace(/&amp;/g, '&');
      const out = addCode(url, p.domains, p.code);
      return out === url ? `${attr}${q}${raw}${q}` : `${attr}${q}${out.replace(/&/g, '&amp;')}${q}`;
    });
  } catch {
    return html;
  }
}

/** Plain-text follow-up body: adds the code to bare URLs of the user's websites. Never throws. */
export async function addLeadCodeToText(userId: number, recipientId: number, text: string): Promise<string> {
  try {
    const p = await prepare(userId, recipientId);
    if (!p) return text;
    return text.replace(/https?:\/\/[^\s<>"'()[\]]+/gi, (match) => {
      const trail = /[.,;:!?]+$/.exec(match)?.[0] ?? '';
      const url = trail ? match.slice(0, -trail.length) : match;
      return addCode(url, p.domains, p.code) + trail;
    });
  } catch {
    return text;
  }
}
