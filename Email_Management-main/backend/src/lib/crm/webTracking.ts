/**
 * Website visitor tracking (step 10). Page views are sent by public/t.js to POST /api/public/track.
 *
 *  - Only websites added in Settings > Website tracking are accepted (host must match crm_sites.domain).
 *  - The full IP is never stored: only a keyed hash (TRACKING_SECRET, else JWT_SECRET).
 *  - Sites with "require consent" only store visits after the page gave consent.
 *  - A valid ?mf= code (lib/crm/linkCode.ts) links the browser to the lead. The first page view
 *    that comes with the code counts as a link click; earlier anonymous views of that browser join the lead.
 *  - Visits and page views older than 180 days are deleted by the CRM worker.
 *  - Page views of a known lead fire the CRM events link_clicked / website_visit (rules + score),
 *    and a key page sends "Ali (email) is on your Pricing page" to the bell, at most once a day per lead.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Request } from 'express';
import { dbPool } from '../db.js';
import { ensureContactForRecipient } from './contacts.js';
import { emitCrmEvent } from './events.js';

/** A new visit starts after this many minutes without a page view. */
const VISIT_GAP_MINUTES = 30;
export const WEB_DATA_RETENTION_DAYS = 180;

type Db = Pick<PoolClient, 'query'>;

const ipSecret = (process.env.TRACKING_SECRET || process.env.JWT_SECRET || '').trim() || randomBytes(32).toString('hex');

let tablesReady = false;
let tablesCheckedAt = 0;

/**
 * True once migration 0037 is applied. CRM queries (rules, score, timeline) only read website data
 * then, so the CRM keeps working when the code is deployed before the migration. Checked at most once a minute.
 */
export async function webTablesReady(db: Db = dbPool): Promise<boolean> {
  if (tablesReady) return true;
  if (Date.now() - tablesCheckedAt < 60_000) return false;
  tablesCheckedAt = Date.now();
  const r = await db.query<{ ok: boolean }>(`SELECT to_regclass('crm_web_pageviews') IS NOT NULL AS ok`);
  tablesReady = r.rows[0]?.ok === true;
  return tablesReady;
}

/** Last result of webTablesReady(), for code that cannot wait (SQL builders). */
export function webTablesKnownReady(): boolean {
  return tablesReady;
}

/** "/book-demo" -> "Book demo", "/" -> "Home". */
export function keyPageName(path: string): string {
  const words = (path.split('/').filter(Boolean).pop() ?? '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Home';
}

/** Public id of a site (ST_...) or form (FM_...). */
export function newPublicKey(prefix: 'ST' | 'FM'): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

/** "https://www.MyShop.com/pricing" -> "myshop.com"; null when it is not a host name. */
export function normalizeDomain(input: unknown): string | null {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (host === 'localhost') return host;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
}

/** True when `host` is the site domain or one of its sub-domains (www.myshop.com, shop.myshop.com). */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return h === domain || h.endsWith(`.${domain}`);
}

/** "/Pricing/" or "https://myshop.com/pricing?x=1" -> "/pricing"; null when empty. */
export function normalizeKeyPage(input: unknown): string | null {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      return null;
    }
  }
  s = s.split(/[?#]/)[0]!.toLowerCase();
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/+$/, '');
  return s ? s.slice(0, 500) : null;
}

/** The key page this path is on ("/pricing" also matches "/pricing/team"), or null. */
export function matchKeyPage(path: string, keyPages: string[]): string | null {
  const p = (normalizeKeyPage(path) ?? '/').toLowerCase();
  return keyPages.find((k) => p === k || p.startsWith(`${k}/`)) ?? null;
}

/** Where t.js, f.js and hosted forms are served: TRACKING_BASE_URL / PUBLIC_URL, else this API's own address. */
export function publicBaseUrl(req: Request): string {
  const base = (process.env.TRACKING_BASE_URL || process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).trim();
  return base.replace(/\/+$/, '');
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || '';
}

export function hashIp(ip: string): string {
  return createHmac('sha256', ipSecret).update(`ip:${ip}`).digest('hex').slice(0, 32);
}

/** "https://x.com/a?b=1#c" -> "https://x.com/a" (no query: it may hold personal data). */
function stripQuery(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.slice(0, 1000);
  } catch {
    return null;
  }
}

export type PageviewInput = {
  siteKey: string;
  visitorKey: string;
  pageUrl: string;
  origin: string | null;
  title: string | null;
  referrer: string | null;
  consent: boolean;
  ipHash: string;
  /** Recipient id from a verified ?mf= code, else null. */
  leadRecipientId: number | null;
  /** The code came in the page URL (a link click), not from the cookie. */
  fromLink: boolean;
};

export type SiteRow = {
  id: number;
  user_id: number;
  domain: string;
  key_pages: string[];
  require_consent: boolean;
};

export type SavedPageview = {
  status: 'saved';
  site: SiteRow;
  visitorId: number;
  contactId: number | null;
  pageviewId: number;
  path: string;
  keyPage: string | null;
  linked: boolean;
  viaLink: boolean;
  recipientId: number | null;
  campaignId: number | null;
};

export type PageviewResult = { status: 'rejected' } | { status: 'no_consent'; site: SiteRow } | SavedPageview;

/** Checks the site and domain, then stores the visitor and the page view. */
export async function recordPageview(input: PageviewInput): Promise<PageviewResult> {
  const siteRes = await dbPool.query<SiteRow>(
    `SELECT id, user_id, domain, key_pages, require_consent
       FROM crm_sites WHERE site_key = $1 AND is_active`,
    [input.siteKey]
  );
  const site = siteRes.rows[0];
  if (!site) return { status: 'rejected' };

  let page: URL;
  try {
    page = new URL(input.pageUrl);
  } catch {
    return { status: 'rejected' };
  }
  if (!/^https?:$/.test(page.protocol) || !hostMatchesDomain(page.hostname, site.domain)) return { status: 'rejected' };
  if (input.origin) {
    let originHost: string;
    try {
      originHost = new URL(input.origin).hostname;
    } catch {
      return { status: 'rejected' };
    }
    if (!hostMatchesDomain(originHost, site.domain)) return { status: 'rejected' };
  }
  if (site.require_consent && !input.consent) return { status: 'no_consent', site };

  const path = (page.pathname || '/').slice(0, 1000);
  const keyPage = matchKeyPage(path, site.key_pages ?? []);

  let lead: { contactId: number; recipientId: number; campaignId: number } | null = null;
  if (input.leadRecipientId) {
    const ref = await ensureContactForRecipient(input.leadRecipientId);
    if (ref && ref.userId === site.user_id) {
      const rec = await dbPool.query<{ campaign_id: number }>(`SELECT campaign_id FROM recipients WHERE id = $1`, [input.leadRecipientId]);
      if (rec.rows[0]) lead = { contactId: ref.contactId, recipientId: input.leadRecipientId, campaignId: rec.rows[0].campaign_id };
    }
  }
  const viaLink = lead != null && input.fromLink;

  const visitor = await dbPool.query<{ id: number; contact_id: number | null; old_contact_id: number | null }>(
    `WITH old AS (SELECT contact_id FROM crm_web_visitors WHERE site_id = $2 AND visitor_key = $3)
     INSERT INTO crm_web_visitors (user_id, site_id, visitor_key, ip_hash, visit_count, pageview_count, contact_id, clicked_at)
     VALUES ($1, $2, $3, $4, 1, 1, $5, CASE WHEN $6::boolean THEN now() END)
     ON CONFLICT (site_id, visitor_key) DO UPDATE SET
       ip_hash = EXCLUDED.ip_hash,
       contact_id = COALESCE(EXCLUDED.contact_id, crm_web_visitors.contact_id),
       clicked_at = CASE WHEN $6::boolean THEN COALESCE(crm_web_visitors.clicked_at, now()) ELSE crm_web_visitors.clicked_at END,
       pageview_count = crm_web_visitors.pageview_count + 1,
       visit_count = crm_web_visitors.visit_count
         + CASE WHEN crm_web_visitors.last_seen_at < now() - make_interval(mins => ${VISIT_GAP_MINUTES}) THEN 1 ELSE 0 END,
       last_seen_at = now()
     RETURNING id, contact_id, (SELECT contact_id FROM old) AS old_contact_id`,
    [site.user_id, site.id, input.visitorKey, input.ipHash, lead?.contactId ?? null, viaLink]
  );
  const v = visitor.rows[0]!;
  if (v.contact_id != null && v.old_contact_id == null) {
    await dbPool.query(
      `UPDATE crm_web_pageviews SET contact_id = $1 WHERE visitor_id = $2 AND contact_id IS NULL`,
      [v.contact_id, v.id]
    );
  }

  const referrer = input.referrer ? stripQuery(input.referrer) : null;
  const pv = await dbPool.query<{ id: number }>(
    `INSERT INTO crm_web_pageviews (user_id, site_id, visitor_id, contact_id, path, title, referrer, is_key_page, via_link, recipient_id, campaign_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      site.user_id, site.id, v.id, v.contact_id, path, input.title?.slice(0, 500) || null, referrer, keyPage != null,
      viaLink, viaLink ? lead!.recipientId : null, viaLink ? lead!.campaignId : null,
    ]
  );

  await dbPool.query(
    `UPDATE crm_sites SET installed_at = COALESCE(installed_at, now()), last_seen_at = now()
      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`,
    [site.id]
  );

  return {
    status: 'saved',
    site,
    visitorId: v.id,
    contactId: v.contact_id,
    pageviewId: pv.rows[0]!.id,
    path,
    keyPage,
    linked: lead != null,
    viaLink,
    recipientId: viaLink ? lead!.recipientId : null,
    campaignId: viaLink ? lead!.campaignId : null,
  };
}

/** CRM side of a saved page view of a known lead: events (rules + score) and the key-page alert. */
export async function emitPageviewEvents(r: SavedPageview): Promise<void> {
  if (r.contactId == null) return;
  const data = { path: r.path, keyPage: r.keyPage, siteId: r.site.id, pageviewId: r.pageviewId };
  if (r.viaLink) {
    await emitCrmEvent(r.site.user_id, r.contactId, { type: 'link_clicked', data: { ...data, campaignId: r.campaignId, recipientId: r.recipientId } });
  }
  await emitCrmEvent(r.site.user_id, r.contactId, { type: 'website_visit', data });
  if (r.keyPage) await keyPageAlert(r, r.contactId);
}

/** "Ali (ali@shop.com) is on your Pricing page", at most once per lead per day. */
async function keyPageAlert(r: SavedPageview, contactId: number): Promise<void> {
  const claimed = await dbPool.query(
    `UPDATE crm_web_visitors SET last_alert_at = now()
      WHERE id = $1 AND NOT EXISTS (
        SELECT 1 FROM crm_web_visitors o
         WHERE o.user_id = $2 AND o.contact_id = $3 AND o.last_alert_at >= date_trunc('day', now()))`,
    [r.visitorId, r.site.user_id, contactId]
  );
  if (!claimed.rowCount) return;
  const c = await dbPool.query<{ email: string; name: string | null }>(
    `SELECT email, name FROM crm_contacts WHERE id = $1 AND user_id = $2`,
    [contactId, r.site.user_id]
  );
  const lead = c.rows[0];
  if (!lead) return;
  const who = lead.name?.trim() ? `${lead.name.trim()} (${lead.email})` : lead.email;
  await dbPool.query(
    `INSERT INTO user_notifications (user_id, type, payload) VALUES ($1, 'crm_key_page', $2::jsonb)`,
    [
      r.site.user_id,
      JSON.stringify({
        contactId,
        email: lead.email,
        name: lead.name,
        page: r.path,
        keyPage: r.keyPage,
        message: `${who} is on your ${keyPageName(r.keyPage!)} page`,
      }),
    ]
  );
}

/** Lead drawer "Website activity": visits, page views, last visit, key pages and the latest pages. */
export async function contactWebsiteActivity(contactId: number, db: Db = dbPool) {
  if (!(await webTablesReady(db))) return null;
  const [totals, pages] = await Promise.all([
    db.query<{ visits: number; pageviews: number; last_visit: string | null; first_click: string | null }>(
      `SELECT COALESCE(sum(visit_count), 0)::int AS visits, COALESCE(sum(pageview_count), 0)::int AS pageviews,
              max(last_seen_at) AS last_visit, min(clicked_at) AS first_click
         FROM crm_web_visitors WHERE contact_id = $1`,
      [contactId]
    ),
    db.query<{ path: string; views: number; last_at: string; key_page: boolean }>(
      `SELECT path, count(*)::int AS views, max(created_at) AS last_at, bool_or(is_key_page) AS key_page
         FROM crm_web_pageviews WHERE contact_id = $1
        GROUP BY path ORDER BY max(created_at) DESC LIMIT 20`,
      [contactId]
    ),
  ]);
  const t = totals.rows[0];
  return {
    totalVisits: t?.visits ?? 0,
    pageviews: t?.pageviews ?? 0,
    lastVisitAt: t?.last_visit ?? null,
    firstClickAt: t?.first_click ?? null,
    keyPages: pages.rows.filter((p) => p.key_page).map((p) => p.path),
    pages: pages.rows.map((p) => ({ path: p.path, views: p.views, lastAt: p.last_at, keyPage: p.key_page })),
  };
}

/** Deletes page views and visitors older than 180 days. Returns the number of page views deleted. */
export async function purgeOldWebData(): Promise<number> {
  const pv = await dbPool.query(
    `DELETE FROM crm_web_pageviews WHERE created_at < now() - make_interval(days => ${WEB_DATA_RETENTION_DAYS})`
  );
  await dbPool.query(
    `DELETE FROM crm_web_visitors WHERE last_seen_at < now() - make_interval(days => ${WEB_DATA_RETENTION_DAYS})`
  );
  return pv.rowCount ?? 0;
}
