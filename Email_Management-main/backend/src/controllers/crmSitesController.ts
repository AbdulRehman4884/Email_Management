/**
 * Step 10: Settings > Website tracking. Mounted in crmRouter at /api/crm (auth + crmEnabled plan check).
 *
 *   GET    /crm/sites                 the user's websites, install status, visits in the last 30 days, script URL
 *   POST   /crm/sites {domain, keyPages?, requireConsent?}
 *   PATCH  /crm/sites/:id {keyPages?, requireConsent?, isActive?}
 *   DELETE /crm/sites/:id             also deletes its visits
 *
 * Every query is limited to the logged-in user's own sites.
 */
import type { Request, Response } from 'express';
import { dbPool } from '../lib/db.js';
import { WEB_DATA_RETENTION_DAYS, newPublicKey, normalizeDomain, normalizeKeyPage, publicBaseUrl } from '../lib/crm/webTracking.js';

const MAX_SITES = 20;
const MAX_KEY_PAGES = 20;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function userIdOf(req: Request): number {
  const id = req.user?.id;
  if (!id) throw new HttpError(401, 'Unauthorized');
  return id;
}

function idParam(req: Request): number {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid site id');
  return n;
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[crm sites]', err);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
}

function keyPagesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'Key pages must be a list like ["/pricing", "/book-demo"]');
  const pages = [...new Set(raw.map(normalizeKeyPage).filter((p): p is string => p != null && p !== ''))];
  if (pages.length > MAX_KEY_PAGES) throw new HttpError(400, `At most ${MAX_KEY_PAGES} key pages per website`);
  return pages;
}

type SiteRow = {
  id: number; site_key: string; domain: string; key_pages: string[]; require_consent: boolean; is_active: boolean;
  installed_at: string | null; last_seen_at: string | null; created_at: string; visitors: number; pageviews: number; leads: number;
};

const SITE_SELECT = `
  SELECT s.id, s.site_key, s.domain, s.key_pages, s.require_consent, s.is_active, s.installed_at, s.last_seen_at, s.created_at,
         (SELECT count(*)::int FROM crm_web_visitors v WHERE v.site_id = s.id AND v.last_seen_at > now() - interval '30 days') AS visitors,
         (SELECT count(*)::int FROM crm_web_pageviews p WHERE p.site_id = s.id AND p.created_at > now() - interval '30 days') AS pageviews,
         (SELECT count(DISTINCT v.contact_id)::int FROM crm_web_visitors v WHERE v.site_id = s.id AND v.contact_id IS NOT NULL) AS leads
    FROM crm_sites s`;

function siteOut(s: SiteRow) {
  return {
    id: s.id,
    siteKey: s.site_key,
    domain: s.domain,
    keyPages: s.key_pages ?? [],
    requireConsent: s.require_consent,
    isActive: s.is_active,
    installed: s.installed_at != null,
    installedAt: s.installed_at,
    lastSeenAt: s.last_seen_at,
    createdAt: s.created_at,
    last30Days: { visitors: s.visitors, pageviews: s.pageviews },
    leads: s.leads,
  };
}

async function readSite(userId: number, id: number) {
  const r = await dbPool.query<SiteRow>(`${SITE_SELECT} WHERE s.id = $1 AND s.user_id = $2`, [id, userId]);
  if (!r.rows[0]) throw new HttpError(404, 'Website not found');
  return siteOut(r.rows[0]);
}

/** GET /crm/sites */
export const listSites = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query<SiteRow>(`${SITE_SELECT} WHERE s.user_id = $1 ORDER BY s.created_at, s.id`, [userId]);
  res.json({ sites: r.rows.map(siteOut), scriptUrl: `${publicBaseUrl(req)}/t.js`, retentionDays: WEB_DATA_RETENTION_DAYS });
});

/** POST /crm/sites */
export const createSite = handle(async (req, res) => {
  const userId = userIdOf(req);
  const domain = normalizeDomain(req.body?.domain);
  if (!domain) throw new HttpError(400, 'Enter a website address like www.myshop.com');
  const keyPages = req.body?.keyPages === undefined ? [] : keyPagesOf(req.body.keyPages);
  const count = await dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_sites WHERE user_id = $1`, [userId]);
  if ((count.rows[0]?.n ?? 0) >= MAX_SITES) throw new HttpError(400, `At most ${MAX_SITES} websites`);
  const r = await dbPool.query<{ id: number }>(
    `INSERT INTO crm_sites (user_id, site_key, domain, key_pages, require_consent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, domain) DO NOTHING
     RETURNING id`,
    [userId, newPublicKey('ST'), domain, keyPages, req.body?.requireConsent === true]
  );
  if (!r.rows[0]) throw new HttpError(409, `${domain} is already added`);
  res.status(201).json({ site: await readSite(userId, r.rows[0].id) });
});

/** PATCH /crm/sites/:id */
export const updateSite = handle(async (req, res) => {
  const userId = userIdOf(req);
  const id = idParam(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const keyPages = body.keyPages === undefined ? null : keyPagesOf(body.keyPages);
  const bool = (v: unknown, name: string) => {
    if (v === undefined) return null;
    if (typeof v !== 'boolean') throw new HttpError(400, `${name} must be true or false`);
    return v;
  };
  const requireConsent = bool(body.requireConsent, 'requireConsent');
  const isActive = bool(body.isActive, 'isActive');
  const r = await dbPool.query(
    `UPDATE crm_sites
        SET key_pages = COALESCE($3, key_pages),
            require_consent = COALESCE($4, require_consent),
            is_active = COALESCE($5, is_active),
            updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [id, userId, keyPages, requireConsent, isActive]
  );
  if (!r.rowCount) throw new HttpError(404, 'Website not found');
  res.json({ site: await readSite(userId, id) });
});

/** DELETE /crm/sites/:id */
export const deleteSite = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query(`DELETE FROM crm_sites WHERE id = $1 AND user_id = $2`, [idParam(req), userId]);
  if (!r.rowCount) throw new HttpError(404, 'Website not found');
  res.json({ ok: true });
});
