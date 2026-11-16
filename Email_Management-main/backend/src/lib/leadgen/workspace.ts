/**
 * The user's side of the Lead Engine (use case UC-10): lead lists, lead detail with field sources,
 * reject, save to CRM, add to campaign. Every query is scoped to the token user; another user's id = not found.
 */
import { dbPool } from '../db.js';
import { ensureDefaultPipeline } from '../crm/pipelines.js';
import { inTransaction } from './resolve.js';
import type { LeadDto, LeadListDto, LeadListParams, LeadStatus, ScoreTier, AddToCampaignResult, SaveToCrmResult } from './types.js';

const MAX_PAGE = 100;

/** The best email of a lead: person (direct) > company direct > company generic. Invalid ones never. */
const BEST_EMAIL_SQL = (alias: string) => `(
  SELECT cp.value_normalized FROM contact_points cp
   WHERE cp.type = 'email' AND cp.verify_status <> 'invalid'
     AND (cp.company_id = ${alias}.company_id OR cp.person_id = ${alias}.person_id
          OR cp.person_id IN (SELECT p.id FROM people p WHERE p.current_company_id = ${alias}.company_id AND p.deleted_at IS NULL AND ${alias}.person_id IS NULL))
   ORDER BY (cp.person_id IS NOT NULL) DESC, (cp.label = 'direct') DESC, cp.mx_valid DESC NULLS LAST, cp.id
   LIMIT 1)`;

interface LeadRow {
  id: number;
  status: LeadStatus;
  fit_score: number;
  score_tier: ScoreTier;
  found_at: string;
  saved_search_id: number | null;
  crm_contact_id: number | null;
  focus_label: string | null;
  company_id: number;
  company_name: string;
  primary_domain: string | null;
  website_url: string | null;
  category: string | null;
  city: string | null;
  country_code: string | null;
  phone: string | null;
  email: string | null;
  linkedin_url: string | null;
  person_id: number | null;
  person_name: string | null;
  person_title: string | null;
  person_linkedin: string | null;
  person_email: string | null;
}

const LEAD_SELECT = `
  SELECT w.id, w.status, w.fit_score, w.score_tier, w.found_at, w.saved_search_id, w.crm_contact_id,
         (SELECT b->>'label' FROM jsonb_array_elements(w.score_breakdown) b WHERE b->>'key' = 'focusMatch' LIMIT 1) AS focus_label,
         c.id AS company_id, c.name AS company_name, c.primary_domain, c.website_url, c.category, c.city, c.country_code,
         (SELECT value_normalized FROM contact_points WHERE company_id = c.id AND type IN ('phone', 'whatsapp') ORDER BY (type = 'phone') DESC, id LIMIT 1) AS phone,
         ${BEST_EMAIL_SQL('w')} AS email,
         (SELECT url FROM social_profiles WHERE company_id = c.id AND platform = 'linkedin' LIMIT 1) AS linkedin_url,
         dm.id AS person_id, dm.full_name AS person_name, dm.title AS person_title, dm.linkedin_url AS person_linkedin,
         (SELECT value_normalized FROM contact_points WHERE person_id = dm.id AND type = 'email' AND verify_status <> 'invalid' LIMIT 1) AS person_email
    FROM workspace_leads w
    JOIN companies c ON c.id = w.company_id AND c.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT p.* FROM people p
       WHERE p.deleted_at IS NULL AND (p.id = w.person_id OR (w.person_id IS NULL AND p.current_company_id = c.id))
       ORDER BY (p.id = w.person_id) DESC NULLS LAST,
                CASE p.seniority WHEN 'owner' THEN 0 WHEN 'c_level' THEN 1 WHEN 'director' THEN 2 WHEN 'manager' THEN 3 ELSE 4 END, p.confidence DESC
       LIMIT 1) dm ON true`;

function toDto(r: LeadRow): LeadDto {
  return {
    id: r.id,
    status: r.status,
    fitScore: r.fit_score,
    scoreTier: r.score_tier,
    foundAt: r.found_at,
    savedSearchId: r.saved_search_id,
    company: {
      id: r.company_id, name: r.company_name, domain: r.primary_domain, websiteUrl: r.website_url, category: r.category,
      city: r.city, countryCode: r.country_code, phone: r.phone, email: r.email, linkedinUrl: r.linkedin_url,
    },
    person: r.person_id ? { id: r.person_id, fullName: r.person_name!, title: r.person_title, linkedinUrl: r.person_linkedin, email: r.person_email } : null,
    crmContactId: r.crm_contact_id,
    focusMatch: r.focus_label ? r.focus_label.replace(/^Matches your focus: /, '') : null,
  };
}

export async function listLeads(userId: number, p: LeadListParams & { q?: string; timezone?: string; matchesFocus?: boolean }): Promise<LeadListDto> {
  const where = ['w.user_id = $1'];
  const args: unknown[] = [userId];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (p.savedSearchId) add('w.saved_search_id = ?', p.savedSearchId);
  if (p.foundToday) {
    args.push(p.timezone ?? 'Asia/Karachi');
    where.push(`w.found_at >= (date_trunc('day', now() AT TIME ZONE $${args.length}) AT TIME ZONE $${args.length})`);
  }
  if (p.tiers?.length) add('w.score_tier = ANY(?)', p.tiers);
  if (p.statuses?.length) add('w.status = ANY(?)', p.statuses);
  else where.push(`w.status <> 'rejected'`);
  if (p.hasEmail === true) where.push(`${BEST_EMAIL_SQL('w')} IS NOT NULL`);
  if (p.hasEmail === false) where.push(`${BEST_EMAIL_SQL('w')} IS NULL`);
  const dm = `EXISTS (SELECT 1 FROM people p WHERE p.current_company_id = w.company_id AND p.deleted_at IS NULL AND p.seniority IN ('owner', 'c_level', 'director'))`;
  if (p.hasDecisionMaker === true) where.push(dm);
  if (p.hasDecisionMaker === false) where.push(`NOT ${dm}`);
  if (p.matchesFocus === true) where.push(`w.score_breakdown @> '[{"key": "focusMatch"}]'::jsonb`);
  if (p.q) {
    args.push(`%${p.q.replace(/[%_\\]/g, '')}%`);
    where.push(`(c.name ILIKE $${args.length} OR c.primary_domain ILIKE $${args.length})`);
  }
  const limit = Math.min(MAX_PAGE, Math.max(1, p.limit ?? 25));
  const page = Math.max(1, p.page ?? 1);
  const whereSql = where.join(' AND ');
  const total = (await dbPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM workspace_leads w JOIN companies c ON c.id = w.company_id AND c.deleted_at IS NULL WHERE ${whereSql}`,
    args
  )).rows[0]?.n ?? 0;
  const rows = await dbPool.query<LeadRow>(
    // Newest day first, best score first within a day (focus matches rise to the top).
    `${LEAD_SELECT} WHERE ${whereSql} ORDER BY date_trunc('day', w.found_at) DESC, w.fit_score DESC, w.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    args
  );
  return { leads: rows.rows.map(toDto), total, page, limit };
}

export async function getLeadDetail(userId: number, leadId: number) {
  const row = (await dbPool.query<LeadRow & { score_breakdown: unknown }>(`${LEAD_SELECT.replace('SELECT w.id,', 'SELECT w.score_breakdown, w.id,')} WHERE w.user_id = $1 AND w.id = $2`, [userId, leadId])).rows[0];
  if (!row) return null;
  const companyId = row.company_id;
  const [company, contacts, socials, people, sources, pages] = await Promise.all([
    dbPool.query(
      `SELECT name, description, address, city, region, country_code, latitude, longitude, employee_range, founded_year, industry,
              tech_stack, hiring_signals, status, data_quality, first_seen_at, last_enriched_at FROM companies WHERE id = $1`, [companyId]),
    dbPool.query(
      `SELECT cp.id, cp.type, cp.value, cp.value_normalized, cp.label, cp.verify_status, cp.mx_valid, cp.source_url, cp.first_seen_at, cp.last_verified_at,
              s.code AS source, p.full_name AS person
         FROM contact_points cp LEFT JOIN sources s ON s.id = cp.source_id LEFT JOIN people p ON p.id = cp.person_id
        WHERE cp.company_id = $1 OR p.current_company_id = $1 ORDER BY cp.type, cp.id`, [companyId]),
    dbPool.query(`SELECT platform, url, found_via, snippet, last_checked_at FROM social_profiles WHERE company_id = $1 ORDER BY platform`, [companyId]),
    dbPool.query(
      `SELECT p.id, p.full_name, p.title, p.seniority, p.department, p.linkedin_url, p.confidence, p.first_seen_at
         FROM people p WHERE p.current_company_id = $1 AND p.deleted_at IS NULL
        ORDER BY CASE p.seniority WHEN 'owner' THEN 0 WHEN 'c_level' THEN 1 WHEN 'director' THEN 2 ELSE 3 END, p.confidence DESC`, [companyId]),
    // "Where did this field come from": the newest observation per field.
    dbPool.query(
      `SELECT DISTINCT ON (o.field) o.field, o.value, o.source_url, o.observed_at, o.confidence, s.code AS source
         FROM observations o LEFT JOIN sources s ON s.id = o.source_id
        WHERE o.entity_type = 'company' AND o.entity_id = $1 AND o.field NOT IN ('external_id', 'site_status')
        ORDER BY o.field, o.observed_at DESC`, [companyId]),
    dbPool.query(`SELECT url, page_type, http_status, last_fetched_at FROM web_pages WHERE company_id = $1 ORDER BY page_type`, [companyId]),
  ]);
  return {
    lead: { ...toDto(row), scoreBreakdown: row.score_breakdown },
    company: company.rows[0],
    contactPoints: contacts.rows,
    socialProfiles: socials.rows,
    people: people.rows,
    fieldSources: sources.rows,
    webPages: pages.rows,
  };
}

/** Status change of the user's own leads. Returns how many changed. */
export async function setLeadStatus(userId: number, leadIds: number[], status: 'rejected' | 'reviewed' | 'new'): Promise<number> {
  const r = await dbPool.query(
    `UPDATE workspace_leads SET status = $3, updated_at = now()
      WHERE user_id = $1 AND id = ANY($2) AND (status <> 'in_campaign' OR $3 = 'rejected')`,
    [userId, leadIds, status]
  );
  return r.rowCount ?? 0;
}

interface ExportLead {
  id: number;
  status: LeadStatus;
  email: string | null;
  mx_valid: boolean | null;
  company: string;
  person: string | null;
  phone: string | null;
  website_url: string | null;
  city: string | null;
}

async function leadsWithEmail(userId: number, leadIds: number[]): Promise<ExportLead[]> {
  const r = await dbPool.query<ExportLead>(
    `SELECT w.id, w.status, e.value_normalized AS email, e.mx_valid, c.name AS company, dm.full_name AS person,
            (SELECT value_normalized FROM contact_points WHERE company_id = c.id AND type = 'phone' LIMIT 1) AS phone,
            c.website_url, c.city
       FROM workspace_leads w
       JOIN companies c ON c.id = w.company_id AND c.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT cp.value_normalized, cp.mx_valid, cp.person_id FROM contact_points cp
          WHERE cp.type = 'email' AND cp.verify_status <> 'invalid'
            AND (cp.company_id = w.company_id OR cp.person_id = w.person_id
                 OR cp.person_id IN (SELECT p.id FROM people p WHERE p.current_company_id = w.company_id AND p.deleted_at IS NULL))
          ORDER BY (cp.person_id IS NOT NULL) DESC, (cp.label = 'direct') DESC, cp.mx_valid DESC NULLS LAST, cp.id LIMIT 1) e ON true
       LEFT JOIN people dm ON dm.id = e.person_id
      WHERE w.user_id = $1 AND w.id = ANY($2) AND w.status <> 'rejected'`,
    [userId, leadIds]
  );
  return r.rows;
}

async function suppressed(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const r = await dbPool.query<{ email: string }>(`SELECT lower(email) AS email FROM suppression_list WHERE lower(email) = ANY($1)`, [emails]);
  return new Set(r.rows.map((x) => x.email));
}

/**
 * Lead -> crm_contacts, ON CONFLICT (user_id, email) upsert: an existing CRM lead keeps its data and only gains
 * missing name/company. Leads without an email or with a suppressed one are skipped (crm_contacts needs an email).
 */
/** CRM tag on every contact that came from the Lead Finder. */
export const LEAD_FINDER_TAG = 'Lead Finder';

export async function saveLeadsToCrm(userId: number, leadIds: number[]): Promise<SaveToCrmResult> {
  const leads = await leadsWithEmail(userId, leadIds);
  const blocked = await suppressed(leads.map((l) => l.email).filter((e): e is string => !!e));
  const out: SaveToCrmResult = { saved: 0, updated: 0, skippedNoEmail: 0, skippedSuppressed: 0 };
  await inTransaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(42031, $1)', [userId]);
    await ensureDefaultPipeline(userId, c);
    const stage = (await c.query<{ pipeline_id: number; stage_id: number | null }>(
      `SELECT p.id AS pipeline_id, (SELECT s.id FROM crm_pipeline_stages s WHERE s.pipeline_id = p.id ORDER BY s.position, s.id LIMIT 1) AS stage_id
         FROM crm_pipelines p WHERE p.user_id = $1 ORDER BY p.is_default DESC, p.id LIMIT 1`,
      [userId]
    )).rows[0];
    // Every lead saved from the Lead Finder carries the "Lead Finder" tag, so the CRM shows (and filters) where it came from.
    const tagId = (await c.query<{ id: number }>(
      `INSERT INTO crm_tags (user_id, name, color, scope) VALUES ($1, $2, '#0ea5e9', 'contact')
       ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [userId, LEAD_FINDER_TAG]
    )).rows[0]!.id;
    for (const l of leads) {
      if (!l.email) {
        out.skippedNoEmail++;
        continue;
      }
      if (blocked.has(l.email)) {
        out.skippedSuppressed++;
        continue;
      }
      const fields = Object.fromEntries(Object.entries({ source: 'lead_finder', phone: l.phone, website: l.website_url, city: l.city }).filter(([, v]) => v)) as Record<string, string>;
      const up = await c.query<{ id: number; inserted: boolean }>(
        `INSERT INTO crm_contacts (user_id, email, name, company, custom_fields, pipeline_id, stage_id, stage_entered_at)
         VALUES ($1, $2, left($3, 255), left($4, 255), $5::jsonb, $6, $7, CASE WHEN $7::int IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (user_id, email) DO UPDATE SET
           name = COALESCE(crm_contacts.name, EXCLUDED.name),
           company = COALESCE(crm_contacts.company, EXCLUDED.company),
           -- Fields the CRM lead already has win (right side of ||).
           custom_fields = EXCLUDED.custom_fields || COALESCE(crm_contacts.custom_fields, '{}'::jsonb),
           updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [userId, l.email, l.person ?? l.company, l.company, JSON.stringify(fields), stage?.pipeline_id ?? null, stage?.stage_id ?? null]
      );
      const contact = up.rows[0]!;
      await c.query(`INSERT INTO crm_contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [contact.id, tagId]);
      if (contact.inserted) {
        out.saved++;
        if (stage?.stage_id) await c.query(`INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, reason) VALUES ($1, NULL, $2, 'created')`, [contact.id, stage.stage_id]);
      } else {
        out.updated++;
      }
      await c.query(
        `UPDATE workspace_leads SET crm_contact_id = $2, status = CASE WHEN status = 'in_campaign' THEN status ELSE 'saved_to_crm' END, updated_at = now()
          WHERE id = $1 AND user_id = $3`,
        [l.id, contact.id, userId]
      );
    }
  });
  return out;
}

export class CampaignNotEditableError extends Error {
  constructor(readonly status: string | null) {
    super(status === null ? 'Campaign not found' : `Leads can only be added to draft or paused campaigns (this one is ${status})`);
  }
}

/** Leads -> recipients of a draft/paused campaign of the user. Only MX-valid, not suppressed, not already in it. */
export async function addLeadsToCampaign(userId: number, leadIds: number[], campaignId: number): Promise<AddToCampaignResult> {
  const campaign = (await dbPool.query<{ status: string; available_columns: string | null }>(
    `SELECT status, available_columns FROM campaigns WHERE id = $1 AND user_id = $2`, [campaignId, userId]
  )).rows[0];
  if (!campaign) throw new CampaignNotEditableError(null);
  if (campaign.status !== 'draft' && campaign.status !== 'paused') throw new CampaignNotEditableError(campaign.status);
  const leads = await leadsWithEmail(userId, leadIds);
  const blocked = await suppressed(leads.map((l) => l.email).filter((e): e is string => !!e));
  const out: AddToCampaignResult = { campaignId, added: 0, skippedNoEmail: 0, skippedDuplicate: 0, skippedSuppressed: 0 };
  await inTransaction(async (c) => {
    await c.query(`SELECT id FROM campaigns WHERE id = $1 FOR UPDATE`, [campaignId]);
    const existing = new Set((await c.query<{ e: string }>(`SELECT lower(email) AS e FROM recipients WHERE campaign_id = $1`, [campaignId])).rows.map((r) => r.e));
    for (const l of leads) {
      if (!l.email || l.mx_valid !== true) {
        out.skippedNoEmail++;
        continue;
      }
      if (blocked.has(l.email)) {
        out.skippedSuppressed++;
        continue;
      }
      if (existing.has(l.email)) {
        out.skippedDuplicate++;
        continue;
      }
      existing.add(l.email);
      const fields = Object.fromEntries(Object.entries({ company: l.company, city: l.city, website: l.website_url, phone: l.phone }).filter(([, v]) => v));
      await c.query(
        `INSERT INTO recipients (campaign_id, email, name, custom_fields, status) VALUES ($1, $2, left($3, 100), $4, 'pending')`,
        [campaignId, l.email, l.person ?? l.company, JSON.stringify(fields)]
      );
      await c.query(`UPDATE workspace_leads SET status = 'in_campaign', updated_at = now() WHERE id = $1 AND user_id = $2`, [l.id, userId]);
      out.added++;
    }
    if (out.added > 0) {
      let cols: string[] = [];
      try {
        cols = campaign.available_columns ? (JSON.parse(campaign.available_columns) as string[]) : [];
      } catch {
        cols = [];
      }
      const merged = [...new Set([...cols, 'company', 'city', 'website', 'phone'])];
      await c.query(
        `UPDATE campaigns SET reciept_count = reciept_count + $2, available_columns = $3, updated_at = now() WHERE id = $1`,
        [campaignId, out.added, JSON.stringify(merged)]
      );
    }
  });
  return out;
}
