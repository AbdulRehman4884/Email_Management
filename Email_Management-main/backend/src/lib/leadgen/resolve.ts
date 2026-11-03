/**
 * Resolution: facts from the collectors -> master data (use case UC-07, UC-08, section 7).
 *
 *   upsertCompanyFromBusiness  match (1) domain, (2) LinkedIn URL, (3) source id seen before, (4) name + city + phone,
 *                              (5) name + city + same spot (~300 m); else a new company. Best values fill gaps only.
 *   applySiteFacts             website crawl -> companies, contact points, social profiles, people, web_pages
 *   upsertPerson               match linkedin_url, then name + company; a known profile at a new company = job change
 *   mergeCompanies             two records turned out to be one: children move to the winner in one transaction
 *   rescoreCompany             fit score of every workspace lead of the company + data_quality
 *   addLeadsForRun             only companies NEW to the user become workspace_leads, within target_per_run and quota
 *
 * Every fact is also written to observations (source, URL, run, confidence) for "where did this come from".
 * Callers pass a client inside a transaction; companies are locked per key with advisory locks.
 */
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';
import { dailyLeadLimit } from './access.js';
import { employeeRange } from './extract.js';
import type { CrawlResult } from './crawler.js';
import { countLeadsFoundToday, isDoNotCollect, notifyUser, type Queryable } from './leadStore.js';
import { departmentOf, seniorityOf } from './linkedin.js';
import { normalizeCompanyName, normalizeDomain, normalizeLinkedinUrl, normalizePersonName, normalizeWebsiteUrl } from './normalize.js';
import { computeFitScore, dataQuality, type ScoreFacts, type Tier } from './score.js';
import { matchFocus } from './focus.js';
import { cleanEmail, emailLabel, normalizePhone } from './verify.js';
import type { DiscoveredBusiness, SocialPlatform } from './types.js';

const LOCK_NS = 74_202;
export const WEBSITE_REFRESH_DAYS = 30;
export const PEOPLE_REFRESH_DAYS = 60;

export interface ResolveContext {
  runId: number | null;
  sourceId: number | null;
}

type Owner = { companyId: number; personId?: undefined } | { personId: number; companyId?: undefined };

/** Runs `fn` in a transaction on its own client. */
export async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── Observations ─────────────────────────────────────────────────────────────

export interface Fact {
  field: string;
  value: unknown;
  sourceUrl?: string | null;
  confidence?: number;
}

export async function observe(q: Queryable, entityType: 'company' | 'person', entityId: number, facts: Fact[], ctx: ResolveContext): Promise<void> {
  const rows = facts
    .filter((f) => f.value !== null && f.value !== undefined && f.value !== '' && !(Array.isArray(f.value) && f.value.length === 0))
    .map((f) => ({ field: f.field.slice(0, 50), value: f.value, source_url: f.sourceUrl?.slice(0, 500) ?? null, confidence: Math.max(0, Math.min(100, Math.round(f.confidence ?? 50))) }));
  if (rows.length === 0) return;
  await q.query(
    `INSERT INTO observations (entity_type, entity_id, field, value, source_id, source_url, run_id, confidence)
     SELECT $1, $2, r.field, r.value, $3, r.source_url, $4, r.confidence
       FROM jsonb_to_recordset($5::jsonb) AS r(field text, value jsonb, source_url text, confidence int)`,
    [entityType, entityId, ctx.sourceId, ctx.runId, JSON.stringify(rows)]
  );
}

// ── Contact points / social profiles ─────────────────────────────────────────

export async function addContactPoint(
  q: Queryable,
  owner: Owner,
  cp: { type: 'email' | 'phone' | 'whatsapp'; value: string; normalized: string; label?: string | null; verifyStatus?: string; mxValid?: boolean | null; sourceUrl?: string | null },
  ctx: ResolveContext
): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO contact_points (company_id, person_id, type, value, value_normalized, label, verify_status, mx_valid, source_id, source_url, last_verified_at)
     VALUES ($1, $2, $3, left($4, 255), left($5, 255), $6, COALESCE($7, 'unverified'), $8, $9, left($10, 500), CASE WHEN $8::boolean IS NULL THEN NULL ELSE now() END)
     ON CONFLICT DO NOTHING`,
    [owner.companyId ?? null, owner.personId ?? null, cp.type, cp.value, cp.normalized, cp.label ?? null, cp.verifyStatus ?? null, cp.mxValid ?? null, ctx.sourceId, cp.sourceUrl ?? null]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Social URL normalized like extract.socialProfileOf (https, lowercase, no query). */
function normalizeSocialUrl(platform: SocialPlatform, url: string): string | null {
  if (platform === 'linkedin') return normalizeLinkedinUrl(url);
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (u.pathname.replace(/\/+$/, '') === '' && !u.searchParams.get('id')) return null;
    const host = u.hostname.toLowerCase().replace(/^(m|mobile)\./, 'www.');
    const id = u.pathname.endsWith('profile.php') ? `?id=${u.searchParams.get('id') ?? ''}` : '';
    return `https://${host}${u.pathname.replace(/\/+$/, '').toLowerCase()}${id}`.slice(0, 500);
  } catch {
    return null;
  }
}

export async function addSocial(
  q: Queryable,
  owner: Owner,
  s: { platform: SocialPlatform; url: string; foundVia: 'website_link' | 'search_result' | 'provider' | 'manual'; snippet?: string | null }
): Promise<boolean> {
  const url = normalizeSocialUrl(s.platform, s.url);
  if (!url) return false;
  const r = await q.query(
    `INSERT INTO social_profiles (company_id, person_id, platform, url, found_via, snippet)
     VALUES ($1, $2, $3, $4, $5, left($6, 300))
     ON CONFLICT (platform, url) DO UPDATE SET last_checked_at = now()
       WHERE social_profiles.company_id IS NOT DISTINCT FROM EXCLUDED.company_id
         AND social_profiles.person_id IS NOT DISTINCT FROM EXCLUDED.person_id
     RETURNING (xmax = 0) AS inserted`,
    [owner.companyId ?? null, owner.personId ?? null, s.platform, url, s.foundVia, s.snippet ?? null]
  );
  return r.rows[0]?.inserted === true;
}

// ── Company matching ─────────────────────────────────────────────────────────

export interface MatchKeys {
  domain: string | null;
  linkedinUrl: string | null;
  externalId: string | null;
  normalizedName: string;
  city: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
}

export async function findCompanyMatch(q: Queryable, k: MatchKeys): Promise<{ id: number; reason: string } | null> {
  if (k.domain) {
    const r = await q.query<{ id: number }>(
      `SELECT c.id FROM company_domains d JOIN companies c ON c.id = d.company_id AND c.deleted_at IS NULL WHERE d.domain = $1`,
      [k.domain]
    );
    if (r.rows[0]) return { id: r.rows[0].id, reason: 'same_domain' };
  }
  if (k.linkedinUrl) {
    const r = await q.query<{ id: number }>(
      `SELECT c.id FROM social_profiles s JOIN companies c ON c.id = s.company_id AND c.deleted_at IS NULL
        WHERE s.platform = 'linkedin' AND s.url = $1`,
      [k.linkedinUrl]
    );
    if (r.rows[0]) return { id: r.rows[0].id, reason: 'same_linkedin' };
  }
  if (k.externalId) {
    const r = await q.query<{ id: number }>(
      `SELECT c.id FROM observations o JOIN companies c ON c.id = o.entity_id AND c.deleted_at IS NULL
        WHERE o.field = 'external_id' AND o.entity_type = 'company' AND (o.value #>> '{}') = $1
        ORDER BY o.id DESC LIMIT 1`,
      [k.externalId]
    );
    if (r.rows[0]) return { id: r.rows[0].id, reason: 'same_source_id' };
  }
  if (k.city && k.phone) {
    const r = await q.query<{ id: number }>(
      `SELECT c.id FROM companies c JOIN contact_points cp ON cp.company_id = c.id AND cp.type IN ('phone', 'whatsapp') AND cp.value_normalized = $3
        WHERE c.normalized_name = $1 AND lower(c.city) = lower($2) AND c.deleted_at IS NULL LIMIT 1`,
      [k.normalizedName, k.city, k.phone]
    );
    if (r.rows[0]) return { id: r.rows[0].id, reason: 'name_city' };
  }
  if (k.city && k.latitude != null && k.longitude != null) {
    const r = await q.query<{ id: number }>(
      `SELECT id FROM companies
        WHERE normalized_name = $1 AND lower(city) = lower($2) AND deleted_at IS NULL
          AND latitude IS NOT NULL AND abs(latitude - $3) < 0.003 AND abs(longitude - $4) < 0.003
        LIMIT 1`,
      [k.normalizedName, k.city, k.latitude, k.longitude]
    );
    if (r.rows[0]) return { id: r.rows[0].id, reason: 'name_city' };
  }
  return null;
}

/** Locks a company key for this transaction (two workers never create the same company twice). */
async function lockKey(q: Queryable, key: string): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [LOCK_NS, key]);
}

/**
 * The domain becomes the company's (company_domains). When another live company owns it, the two are one
 * business: they are merged (the older record wins). Returns the surviving company id.
 */
async function claimDomain(q: Queryable, companyId: number, domain: string, primary: boolean): Promise<number> {
  const owner = await q.query<{ company_id: number }>(
    `SELECT d.company_id FROM company_domains d JOIN companies c ON c.id = d.company_id AND c.deleted_at IS NULL WHERE d.domain = $1`,
    [domain]
  );
  const other = owner.rows[0]?.company_id;
  if (other && other !== companyId) {
    const [winner, loser] = other < companyId ? [other, companyId] : [companyId, other];
    await mergeCompanies(q, winner, loser, 'same_domain');
    return winner;
  }
  if (!other) {
    // A domain of a deleted (merged/erased) company is free again.
    await q.query(`DELETE FROM company_domains d USING companies c WHERE d.domain = $1 AND c.id = d.company_id AND c.deleted_at IS NOT NULL`, [domain]);
    await q.query(`INSERT INTO company_domains (company_id, domain, is_primary) VALUES ($1, $2, $3) ON CONFLICT (domain) DO NOTHING`, [companyId, domain, primary]);
    if (primary) {
      await q.query(`UPDATE companies SET primary_domain = $2 WHERE id = $1 AND primary_domain IS NULL`, [companyId, domain]);
    }
  }
  return companyId;
}

export async function upsertCompanyFromBusiness(
  q: Queryable,
  b: DiscoveredBusiness,
  ctx: ResolveContext
): Promise<{ companyId: number; created: boolean; matchedBy: string | null }> {
  const normalizedName = normalizeCompanyName(b.name) || b.name.toLowerCase();
  const domain = b.domain ?? normalizeDomain(b.websiteUrl);
  const phone = normalizePhone(b.phone, b.countryCode);
  const email = cleanEmail(b.email);
  const linkedin = b.socials.find((s) => s.platform === 'linkedin');
  const keys: MatchKeys = {
    domain,
    linkedinUrl: linkedin ? normalizeLinkedinUrl(linkedin.url) : null,
    externalId: b.externalId,
    normalizedName,
    city: b.city,
    phone,
    latitude: b.latitude,
    longitude: b.longitude,
  };
  await lockKey(q, domain ?? `${normalizedName}|${(b.city ?? '').toLowerCase()}`);
  const match = await findCompanyMatch(q, keys);

  let companyId: number;
  let created = false;
  const websiteUrl = normalizeWebsiteUrl(b.websiteUrl);
  // UC-08 step 4: the domain says company X but this exact business (same source id) is stored as Y:
  // X and Y are one business. Merge them (the older record wins).
  if (match && match.reason !== 'same_source_id' && b.externalId) {
    const bySourceId = await findCompanyMatch(q, { ...keys, domain: null, linkedinUrl: null });
    if (bySourceId && bySourceId.reason === 'same_source_id' && bySourceId.id !== match.id) {
      const [winner, loser] = bySourceId.id < match.id ? [bySourceId.id, match.id] : [match.id, bySourceId.id];
      await mergeCompanies(q, winner, loser, match.reason);
      match.id = winner;
    }
  }
  if (match) {
    companyId = match.id;
    await q.query(
      `UPDATE companies SET
          website_url = COALESCE(website_url, $2), category = COALESCE(category, $3), address = COALESCE(address, left($4, 500)),
          city = COALESCE(city, $5), region = COALESCE(region, $6), country_code = COALESCE(country_code, $7),
          latitude = COALESCE(latitude, $8), longitude = COALESCE(longitude, $9)
        WHERE id = $1`,
      [companyId, websiteUrl, b.category, b.address, b.city, b.region, b.countryCode, b.latitude, b.longitude]
    );
  } else {
    const ins = await q.query<{ id: number }>(
      `INSERT INTO companies (name, normalized_name, website_url, category, address, city, region, country_code, latitude, longitude, next_refresh_at)
       VALUES (left($1, 255), left($2, 255), $3, $4, left($5, 500), $6, $7, $8, $9, $10, now() + interval '${WEBSITE_REFRESH_DAYS} days')
       RETURNING id`,
      [b.name, normalizedName, websiteUrl, b.category, b.address, b.city, b.region, b.countryCode, b.latitude, b.longitude]
    );
    companyId = ins.rows[0]!.id;
    created = true;
  }
  if (domain) companyId = await claimDomain(q, companyId, domain, true);

  const owner = { companyId };
  if (phone) await addContactPoint(q, owner, { type: 'phone', value: b.phone!, normalized: phone, sourceUrl: b.sourceUrl }, ctx);
  if (email) await addContactPoint(q, owner, { type: 'email', value: email, normalized: email, label: emailLabel(email), sourceUrl: b.sourceUrl }, ctx);
  for (const s of b.socials) await addSocial(q, owner, { platform: s.platform, url: s.url, foundVia: b.sourceCode === 'osm' ? 'website_link' : 'search_result' });
  await observe(q, 'company', companyId, [
    { field: 'external_id', value: b.externalId, sourceUrl: b.sourceUrl, confidence: 100 },
    { field: 'name', value: b.name, sourceUrl: b.sourceUrl, confidence: b.confidence },
    { field: 'website', value: websiteUrl, sourceUrl: b.sourceUrl, confidence: b.confidence },
    { field: 'phone', value: phone, sourceUrl: b.sourceUrl, confidence: b.confidence },
    { field: 'email', value: email, sourceUrl: b.sourceUrl, confidence: b.confidence },
    { field: 'address', value: b.address, sourceUrl: b.sourceUrl, confidence: b.confidence },
    { field: 'category', value: b.category, sourceUrl: b.sourceUrl, confidence: b.confidence },
    { field: 'location', value: b.latitude != null ? { lat: b.latitude, lon: b.longitude } : null, sourceUrl: b.sourceUrl, confidence: b.confidence },
  ], ctx);
  return { companyId, created, matchedBy: match?.reason ?? null };
}

// ── Merge ────────────────────────────────────────────────────────────────────

/** Status rank: the better row survives a merge. A rejection is a user decision and always wins. */
const STATUS_RANK = `CASE status WHEN 'rejected' THEN 5 WHEN 'in_campaign' THEN 4 WHEN 'saved_to_crm' THEN 3 WHEN 'reviewed' THEN 2 ELSE 1 END`;

export async function mergeCompanies(q: Queryable, winnerId: number, loserId: number, reason: string): Promise<void> {
  if (winnerId === loserId) return;
  await q.query(`UPDATE company_domains SET company_id = $1, is_primary = false WHERE company_id = $2`, [winnerId, loserId]);
  await q.query(
    `UPDATE contact_points l SET company_id = $1 WHERE l.company_id = $2
       AND NOT EXISTS (SELECT 1 FROM contact_points w WHERE w.company_id = $1 AND w.type = l.type AND w.value_normalized = l.value_normalized)`,
    [winnerId, loserId]
  );
  await q.query(`DELETE FROM contact_points WHERE company_id = $1`, [loserId]);
  await q.query(`UPDATE social_profiles SET company_id = $1 WHERE company_id = $2`, [winnerId, loserId]);
  await q.query(
    `UPDATE employments l SET company_id = $1 WHERE l.company_id = $2
       AND NOT (l.is_current AND EXISTS (SELECT 1 FROM employments w WHERE w.company_id = $1 AND w.person_id = l.person_id AND w.is_current))`,
    [winnerId, loserId]
  );
  await q.query(`DELETE FROM employments WHERE company_id = $1`, [loserId]);
  await q.query(`UPDATE people SET current_company_id = $1 WHERE current_company_id = $2`, [winnerId, loserId]);
  await q.query(`UPDATE web_pages SET company_id = $1 WHERE company_id = $2`, [winnerId, loserId]);
  // workspace_leads: a user who has both keeps one row, the one with the better status.
  await q.query(
    `UPDATE workspace_leads w SET status = l.status, crm_contact_id = COALESCE(w.crm_contact_id, l.crm_contact_id), updated_at = now()
       FROM workspace_leads l
      WHERE w.company_id = $1 AND l.company_id = $2 AND l.user_id = w.user_id
        AND COALESCE(l.person_id, 0) = COALESCE(w.person_id, 0)
        AND (${STATUS_RANK.replace(/status/g, 'l.status')}) > (${STATUS_RANK.replace(/status/g, 'w.status')})`,
    [winnerId, loserId]
  );
  await q.query(
    `DELETE FROM workspace_leads l USING workspace_leads w
      WHERE l.company_id = $2 AND w.company_id = $1 AND l.user_id = w.user_id AND COALESCE(l.person_id, 0) = COALESCE(w.person_id, 0)`,
    [winnerId, loserId]
  );
  await q.query(`UPDATE workspace_leads SET company_id = $1, updated_at = now() WHERE company_id = $2`, [winnerId, loserId]);
  await q.query(`UPDATE observations SET entity_id = $1 WHERE entity_type = 'company' AND entity_id = $2`, [winnerId, loserId]);
  await q.query(`UPDATE scrape_tasks SET company_id = $1 WHERE company_id = $2`, [winnerId, loserId]);
  // The loser frees its domain first (unique index), then the winner fills its gaps from it.
  const loser = (await q.query<{ primary_domain: string | null }>(
    `UPDATE companies n SET deleted_at = now(), primary_domain = NULL FROM companies o WHERE n.id = $1 AND o.id = n.id RETURNING o.primary_domain`,
    [loserId]
  )).rows[0];
  await q.query(
    `UPDATE companies w SET website_url = COALESCE(w.website_url, l.website_url), description = COALESCE(w.description, l.description),
            address = COALESCE(w.address, l.address), latitude = COALESCE(w.latitude, l.latitude), longitude = COALESCE(w.longitude, l.longitude),
            primary_domain = COALESCE(w.primary_domain, $3)
       FROM companies l WHERE w.id = $1 AND l.id = $2`,
    [winnerId, loserId, loser?.primary_domain ?? null]
  );
  await q.query(`UPDATE companies w SET primary_domain = (SELECT domain FROM company_domains WHERE company_id = w.id ORDER BY is_primary DESC, id LIMIT 1) WHERE w.id = $1 AND w.primary_domain IS NULL`, [winnerId]);
  await q.query(`INSERT INTO entity_merges (entity_type, winner_id, loser_id, reason) VALUES ('company', $1, $2, $3)`, [winnerId, loserId, reason]);
}

// ── People ───────────────────────────────────────────────────────────────────

export interface PersonInput {
  fullName: string;
  title: string | null;
  linkedinUrl: string | null;
  email?: string | null;
  sourceUrl?: string | null;
  foundVia: 'website_link' | 'search_result' | 'provider' | 'manual';
  /** 0-100. */
  confidence: number;
  emailVerified?: boolean;
}

export async function upsertPerson(
  q: Queryable,
  companyId: number,
  p: PersonInput,
  ctx: ResolveContext
): Promise<{ personId: number; created: boolean; jobChange: boolean } | null> {
  const linkedinUrl = p.linkedinUrl ? normalizeLinkedinUrl(p.linkedinUrl) : null;
  const email = cleanEmail(p.email);
  if (await isDoNotCollect([{ type: 'linkedin_url', value: linkedinUrl }, { type: 'email', value: email }], q)) return null;
  const normalizedName = normalizePersonName(p.fullName);
  if (!normalizedName) return null;
  await lockKey(q, linkedinUrl ?? `p|${normalizedName}|${companyId}`);

  let row: { id: number; current_company_id: number | null; confidence: number } | undefined;
  if (linkedinUrl) {
    row = (await q.query<{ id: number; current_company_id: number | null; confidence: number }>(
      `SELECT id, current_company_id, confidence FROM people WHERE linkedin_url = $1 AND deleted_at IS NULL`,
      [linkedinUrl]
    )).rows[0];
  }
  row ??= (await q.query<{ id: number; current_company_id: number | null; confidence: number }>(
    `SELECT id, current_company_id, confidence FROM people WHERE normalized_name = $1 AND current_company_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [normalizedName, companyId]
  )).rows[0];

  const company = (await q.query<{ city: string | null; country_code: string | null; name: string }>(`SELECT city, country_code, name FROM companies WHERE id = $1`, [companyId])).rows[0];
  let personId: number;
  let created = false;
  let jobChange = false;
  if (row) {
    personId = row.id;
    jobChange = row.current_company_id !== null && row.current_company_id !== companyId && !!linkedinUrl;
    await q.query(
      `UPDATE people SET last_seen_at = now(),
              title = CASE WHEN $2::text IS NOT NULL AND ($3 >= confidence OR title IS NULL OR $4) THEN left($2, 255) ELSE title END,
              seniority = COALESCE(CASE WHEN $2::text IS NOT NULL AND ($3 >= confidence OR $4) THEN $5 END, seniority),
              department = COALESCE(CASE WHEN $2::text IS NOT NULL AND ($3 >= confidence OR $4) THEN $6 END, department),
              linkedin_url = COALESCE(linkedin_url, $7), confidence = GREATEST(confidence, $3),
              current_company_id = CASE WHEN $4 THEN $8 ELSE COALESCE(current_company_id, $8) END,
              next_refresh_at = now() + interval '${PEOPLE_REFRESH_DAYS} days'
        WHERE id = $1`,
      [personId, p.title, p.confidence, jobChange, seniorityOf(p.title), departmentOf(p.title), linkedinUrl, companyId]
    );
    if (jobChange) {
      await q.query(`UPDATE employments SET is_current = false, ended_at = now() WHERE person_id = $1 AND is_current AND company_id <> $2`, [personId, companyId]);
      await notifyJobChange(q, personId, p.fullName, company?.name ?? 'a new company');
    }
  } else {
    const ins = await q.query<{ id: number }>(
      `INSERT INTO people (full_name, normalized_name, title, seniority, department, current_company_id, city, country_code, linkedin_url, confidence, next_refresh_at)
       VALUES (left($1, 255), left($2, 255), left($3, 255), $4, $5, $6, $7, $8, $9, $10, now() + interval '${PEOPLE_REFRESH_DAYS} days')
       RETURNING id`,
      [p.fullName.trim(), normalizedName, p.title, seniorityOf(p.title), departmentOf(p.title), companyId, company?.city ?? null, company?.country_code ?? null, linkedinUrl, p.confidence]
    );
    personId = ins.rows[0]!.id;
    created = true;
  }
  await q.query(
    `INSERT INTO employments (person_id, company_id, title, is_current) VALUES ($1, $2, left($3, 255), true) ON CONFLICT DO NOTHING`,
    [personId, companyId, p.title]
  );
  if (linkedinUrl) await addSocial(q, { personId }, { platform: 'linkedin', url: linkedinUrl, foundVia: p.foundVia });
  // A person's email only when it was published on the website or is provider-verified (no guessing).
  if (email) {
    await addContactPoint(q, { personId }, {
      type: 'email', value: email, normalized: email, label: 'direct', sourceUrl: p.sourceUrl ?? null,
      verifyStatus: p.emailVerified ? 'valid' : undefined,
    }, ctx);
  }
  await observe(q, 'person', personId, [
    { field: 'full_name', value: p.fullName, sourceUrl: p.sourceUrl, confidence: p.confidence },
    { field: 'title', value: p.title, sourceUrl: p.sourceUrl, confidence: p.confidence },
    { field: 'linkedin_url', value: linkedinUrl, sourceUrl: p.sourceUrl, confidence: p.confidence },
    { field: 'email', value: email, sourceUrl: p.sourceUrl, confidence: p.confidence },
    { field: 'company_id', value: companyId, sourceUrl: p.sourceUrl, confidence: p.confidence },
  ], ctx);
  return { personId, created, jobChange };
}

/** Bell for every user whose CRM has this person (UC-09 step 4). */
async function notifyJobChange(q: Queryable, personId: number, fullName: string, companyName: string): Promise<void> {
  const users = await q.query<{ user_id: number }>(
    `SELECT DISTINCT cc.user_id FROM crm_contacts cc
       JOIN contact_points cp ON cp.person_id = $1 AND cp.type = 'email' AND cp.value_normalized = cc.email`,
    [personId]
  );
  for (const u of users.rows) {
    await notifyUser(u.user_id, 'leadgen_job_change', { personId, message: `${fullName} moved to ${companyName}.` }, q);
  }
}

// ── Website facts ────────────────────────────────────────────────────────────

export async function applySiteFacts(q: Queryable, companyId: number, crawl: CrawlResult, ctx: ResolveContext): Promise<{ newEmails: number; newPeople: number }> {
  for (const p of crawl.pages) {
    await q.query(
      `INSERT INTO web_pages (company_id, url, page_type, http_status, content_hash, robots_allowed, last_fetched_at)
       VALUES ($1, left($2, 500), $3, $4, $5, $6, now())
       ON CONFLICT (url) DO UPDATE SET page_type = EXCLUDED.page_type, http_status = EXCLUDED.http_status,
              content_hash = COALESCE(EXCLUDED.content_hash, web_pages.content_hash), robots_allowed = EXCLUDED.robots_allowed,
              last_fetched_at = now()`,
      [companyId, p.url, p.pageType, p.httpStatus, p.contentHash, p.robotsAllowed]
    );
  }
  await observe(q, 'company', companyId, [{ field: 'site_status', value: crawl.status, sourceUrl: crawl.finalUrl, confidence: 100 }], ctx);
  if (crawl.status === 'down') {
    // Down 3 times in a row -> status unknown (UC-04 alternate flow).
    const last = await q.query<{ v: string }>(
      `SELECT value #>> '{}' AS v FROM observations WHERE entity_type = 'company' AND entity_id = $1 AND field = 'site_status' ORDER BY id DESC LIMIT 3`,
      [companyId]
    );
    if (last.rows.length === 3 && last.rows.every((r) => r.v === 'down')) await q.query(`UPDATE companies SET status = 'unknown' WHERE id = $1`, [companyId]);
    await q.query(`UPDATE companies SET next_refresh_at = now() + interval '${WEBSITE_REFRESH_DAYS} days' WHERE id = $1`, [companyId]);
    return { newEmails: 0, newPeople: 0 };
  }
  if (crawl.redirectedDomain) {
    // Add the redirect target only when no other company has it.
    await q.query(
      `INSERT INTO company_domains (company_id, domain, is_primary) VALUES ($1, $2, false) ON CONFLICT (domain) DO NOTHING`,
      [companyId, crawl.redirectedDomain]
    );
  }
  await q.query(
    `UPDATE companies SET status = 'active', last_enriched_at = now(), next_refresh_at = now() + interval '${WEBSITE_REFRESH_DAYS} days' WHERE id = $1`,
    [companyId]
  );
  if (crawl.unchanged) return { newEmails: 0, newPeople: 0 };

  const f = crawl.facts;
  const company = (await q.query<{ country_code: string | null; tech_stack: string[] }>(`SELECT country_code, tech_stack FROM companies WHERE id = $1`, [companyId])).rows[0];
  const country = company?.country_code ?? f.address?.countryCode ?? null;
  const thisYear = new Date().getFullYear();
  const founded = f.foundedYear && f.foundedYear <= thisYear ? f.foundedYear : null;
  const tech = [...new Set([...(company?.tech_stack ?? []), ...f.techStack])];
  await q.query(
    `UPDATE companies SET description = COALESCE(left($2, 2000), description), founded_year = COALESCE(founded_year, $3),
            employee_range = COALESCE(employee_range, $4), tech_stack = $5::jsonb,
            hiring_signals = $6::jsonb, address = COALESCE(address, left($7, 500)), city = COALESCE(city, $8),
            region = COALESCE(region, $9), country_code = COALESCE(country_code, $10),
            site_topics = CASE WHEN jsonb_array_length($11::jsonb) > 0 THEN $11::jsonb ELSE site_topics END
      WHERE id = $1`,
    [companyId, f.description, founded, employeeRange(f.employeeCount), JSON.stringify(tech),
      JSON.stringify({ careers_page: !!f.careersPage, open_roles: f.openRoles }), f.address?.street ?? null, f.address?.city ?? null,
      f.address?.region ?? null, f.address?.countryCode ?? null, JSON.stringify(f.topics.slice(0, 80))]
  );

  const owner = { companyId };
  let newEmails = 0;
  const domain = (await q.query<{ primary_domain: string | null }>(`SELECT primary_domain FROM companies WHERE id = $1`, [companyId])).rows[0]?.primary_domain;
  const teamEmails = new Set(f.team.map((t) => cleanEmail(t.email)).filter(Boolean) as string[]);
  for (const e of f.emails) {
    const email = cleanEmail(e.value);
    if (!email || teamEmails.has(email)) continue;
    if (await isDoNotCollect([{ type: 'email', value: email }], q)) continue;
    // Free-mail addresses (gmail ...) of a business are kept; other-domain addresses are kept too but only the
    // site's own domain can be "direct".
    const label = emailLabel(email);
    if (await addContactPoint(q, owner, { type: 'email', value: email, normalized: email, label: domain && !email.endsWith(`@${domain}`) && label === 'direct' ? 'generic' : label, sourceUrl: e.sourceUrl }, ctx)) newEmails++;
  }
  for (const ph of f.phones) {
    const n = normalizePhone(ph.value, country);
    if (n) await addContactPoint(q, owner, { type: 'phone', value: ph.value, normalized: n, sourceUrl: ph.sourceUrl }, ctx);
  }
  for (const wa of f.whatsapp) {
    const n = normalizePhone(wa.value, country);
    if (n) await addContactPoint(q, owner, { type: 'whatsapp', value: wa.value, normalized: n, sourceUrl: wa.sourceUrl }, ctx);
  }
  for (const s of f.socials) await addSocial(q, owner, { platform: s.platform, url: s.url, foundVia: 'website_link' });

  let newPeople = 0;
  for (const t of f.team) {
    const r = await upsertPerson(q, companyId, {
      fullName: t.fullName, title: t.title, linkedinUrl: t.linkedinUrl, email: t.email, sourceUrl: t.sourceUrl, foundVia: 'website_link', confidence: 60,
    }, ctx);
    if (r?.created) newPeople++;
  }
  await observe(q, 'company', companyId, [
    { field: 'description', value: f.description?.slice(0, 300), sourceUrl: crawl.finalUrl, confidence: 70 },
    { field: 'founded_year', value: founded, sourceUrl: crawl.finalUrl, confidence: 70 },
    { field: 'employee_count', value: f.employeeCount, sourceUrl: crawl.finalUrl, confidence: 60 },
    { field: 'tech_stack', value: f.techStack, sourceUrl: crawl.finalUrl, confidence: 90 },
    { field: 'open_roles', value: f.careersPage ? f.openRoles : null, sourceUrl: f.careersPage, confidence: 70 },
    ...f.emails.map((e) => ({ field: 'email', value: e.value, sourceUrl: e.sourceUrl, confidence: 80 })),
    ...f.phones.map((p) => ({ field: 'phone', value: p.value, sourceUrl: p.sourceUrl, confidence: 80 })),
    ...f.socials.map((s) => ({ field: `social_${s.platform}`, value: s.url, sourceUrl: s.sourceUrl, confidence: 90 })),
  ], ctx);
  return { newEmails, newPeople };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

interface CompanyFactsRow {
  /** Name + industry + description + website topics: matched against a search's focus. */
  focus_text: string;
  category: string | null;
  city: string | null;
  website_url: string | null;
  address: string | null;
  description: string | null;
  status: string;
  recently_live: boolean;
  has_phone: boolean;
  has_email: boolean;
  has_mx_email: boolean;
  has_direct_email: boolean;
  has_dm: boolean;
  has_linkedin: boolean;
  hiring: boolean;
}

export async function companyScoreFacts(q: Queryable, companyId: number): Promise<CompanyFactsRow | null> {
  const r = await q.query<CompanyFactsRow>(
    `SELECT concat_ws(' ', c.name, c.industry, c.description, (SELECT string_agg(t, ' ') FROM jsonb_array_elements_text(c.site_topics) t)) AS focus_text,
            c.category, c.city, c.website_url, c.address, c.description, c.status,
            (c.last_enriched_at > now() - interval '90 days' AND c.status = 'active') AS recently_live,
            EXISTS (SELECT 1 FROM contact_points WHERE company_id = c.id AND type IN ('phone', 'whatsapp')) AS has_phone,
            EXISTS (SELECT 1 FROM contact_points cp LEFT JOIN people p ON p.id = cp.person_id
                     WHERE cp.type = 'email' AND cp.verify_status <> 'invalid' AND (cp.company_id = c.id OR (p.current_company_id = c.id AND p.deleted_at IS NULL))) AS has_email,
            EXISTS (SELECT 1 FROM contact_points cp LEFT JOIN people p ON p.id = cp.person_id
                     WHERE cp.type = 'email' AND cp.mx_valid AND (cp.company_id = c.id OR (p.current_company_id = c.id AND p.deleted_at IS NULL))) AS has_mx_email,
            EXISTS (SELECT 1 FROM contact_points cp LEFT JOIN people p ON p.id = cp.person_id
                     WHERE cp.type = 'email' AND cp.label = 'direct' AND (cp.company_id = c.id OR (p.current_company_id = c.id AND p.deleted_at IS NULL))) AS has_direct_email,
            EXISTS (SELECT 1 FROM people p WHERE p.current_company_id = c.id AND p.deleted_at IS NULL AND p.seniority IN ('owner', 'c_level', 'director')) AS has_dm,
            EXISTS (SELECT 1 FROM social_profiles WHERE company_id = c.id AND platform = 'linkedin') AS has_linkedin,
            (COALESCE((c.hiring_signals->>'open_roles')::int, 0) > 0 OR COALESCE((c.hiring_signals->>'careers_page')::boolean, false)) AS hiring
       FROM companies c WHERE c.id = $1`,
    [companyId]
  );
  return r.rows[0] ?? null;
}

/** Recomputes data_quality and the fit score of every workspace lead of the company. Returns the best tier. */
export async function rescoreCompany(q: Queryable, companyId: number): Promise<Tier | null> {
  const c = await companyScoreFacts(q, companyId);
  if (!c) return null;
  await q.query(`UPDATE companies SET data_quality = $2 WHERE id = $1`, [
    companyId,
    dataQuality({ hasWebsite: !!c.website_url, hasPhone: c.has_phone, hasEmail: c.has_email, hasLinkedin: c.has_linkedin, hasDecisionMaker: c.has_dm, hasAddress: !!c.address, hasDescription: !!c.description }),
  ]);
  const leads = await q.query<{ id: number; category: string | null; city: string | null; keywords: string[] | null }>(
    `SELECT w.id, ss.category, ss.city, ss.keywords FROM workspace_leads w LEFT JOIN saved_searches ss ON ss.id = w.saved_search_id WHERE w.company_id = $1`,
    [companyId]
  );
  let best: Tier | null = null;
  const rank = { cold: 0, warm: 1, hot: 2 } as const;
  for (const l of leads.rows) {
    const facts: ScoreFacts = {
      categoryMatch: !!l.category && l.category === c.category,
      cityMatch: !!l.city && !!c.city && l.city.toLowerCase() === c.city.toLowerCase(),
      hasWebsite: !!c.website_url,
      hasPhone: c.has_phone,
      hasEmail: c.has_email,
      hasVerifiedEmail: c.has_mx_email,
      hasDirectEmail: c.has_direct_email,
      hasDecisionMaker: c.has_dm,
      hasLinkedin: c.has_linkedin,
      hiring: c.hiring,
      websiteActive: c.recently_live,
      // Keyword-only searches (no category) were already found by those words: only a category search has a focus.
      focusMatch: l.category ? matchFocus(l.keywords ?? [], c.focus_text) : null,
    };
    const s = computeFitScore(facts);
    await q.query(
      `UPDATE workspace_leads SET fit_score = $2, score_tier = $3, score_breakdown = $4::jsonb, updated_at = now() WHERE id = $1`,
      [l.id, s.score, s.tier, JSON.stringify(s.breakdown)]
    );
    if (!best || rank[s.tier] > rank[best]) best = s.tier;
  }
  return best;
}

// ── Workspace leads ──────────────────────────────────────────────────────────

const USER_LEAD_LOCK_NS = 74_203;

/**
 * Companies that are new to the user become workspace_leads (status new) until the run has target_per_run
 * new leads or the user's daily quota is used up. Returns the company ids that became leads.
 */
export async function addLeadsForRun(
  q: Queryable,
  run: { runId: number; userId: number; savedSearchId: number | null; targetPerRun: number; timezone: string },
  companyIds: number[]
): Promise<{ added: number[]; quotaHit: boolean; targetReached: boolean }> {
  await q.query(`SELECT pg_advisory_xact_lock($1, $2)`, [USER_LEAD_LOCK_NS, run.userId]);
  const inRun = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_leads WHERE first_run_id = $1`, [run.runId])).rows[0]?.n ?? 0;
  const limit = await dailyLeadLimit(run.userId);
  const today = await countLeadsFoundToday(run.userId, run.timezone, q);
  let room = Math.min(run.targetPerRun - inRun, limit - today);
  const added: number[] = [];
  for (const companyId of [...new Set(companyIds)]) {
    if (room <= 0) break;
    const r = await q.query(
      `INSERT INTO workspace_leads (user_id, company_id, saved_search_id, first_run_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [run.userId, companyId, run.savedSearchId, run.runId]
    );
    if ((r.rowCount ?? 0) > 0) {
      added.push(companyId);
      room--;
    }
  }
  const quotaHit = limit - today - added.length <= 0 && run.targetPerRun - inRun - added.length > 0;
  return { added, quotaHit, targetReached: run.targetPerRun - inRun - added.length <= 0 };
}
