/**
 * What each scrape_tasks.task_type does, and how errors become retry / skip / fail.
 *
 *   discover         source (OSM / search) -> businesses -> companies (dedupe) -> NEW workspace leads
 *                    (target_per_run, daily quota) -> fetch_site + find_social for the new leads
 *   fetch_site       crawl the website (max 8 pages) -> master data; MX check of new emails; rescore;
 *                    hot lead + provider key -> provider_enrich
 *   find_social      LinkedIn company page (+ decision makers when the search wants people) from search results;
 *                    refresh of a known person -> job change check
 *   verify_email     MX check of one email (nightly refresh)
 *   provider_enrich  licensed provider (PDL) for a hot lead's domain
 */
import { FetchError, SourceBlockedError, SourceUnavailableError } from './errors.js';
import { safeFetch } from './http.js';
import { politeFetch } from './fetchPage.js';
import { crawlSite } from './crawler.js';
import { cacheGet, cacheSet, getSourceByCode, isDoNotCollect, listSources, MAX_BLOCKS_PER_DAY, notifyAdmins, recordSourceBlock, recordSourceRequests, sourceAvailability } from './leadStore.js';
import { companyNamesMatch, currentCompanyOf, findCompanyLinkedin, findPeople } from './linkedin.js';
import { normalizeCompanyName } from './normalize.js';
import { enrichWithProvider, pdlApiKey } from './provider.js';
import { addLeadsForRun, addSocial, applySiteFacts, inTransaction, rescoreCompany, upsertCompanyFromBusiness, upsertPerson, WEBSITE_REFRESH_DAYS, type ResolveContext } from './resolve.js';
import { createSourceContext, DISCOVERY_SOURCES, isSourceConfigured, SEARCH_PROVIDERS } from './sources/index.js';
import { failTask, type ClaimedTask, type NewTask, type TaskOutcome } from './taskQueue.js';
import { hasMx } from './verify.js';
import { matchFocus } from './focus.js';
import { dbPool } from '../db.js';
import type { DiscoveredBusiness, DiscoveryQuery, ScrapeTaskType, SearchProvider, SourceRow } from './types.js';

export type TaskHandler = (task: ClaimedTask) => Promise<TaskOutcome>;

const ctxOf = (task: ClaimedTask): ResolveContext => ({ runId: task.runId, sourceId: task.sourceId });

/** The search provider for LinkedIn lookups: the paid SERP API when it has a key, else DuckDuckGo. */
async function linkedinSearch(): Promise<{ provider: SearchProvider; row: SourceRow } | null> {
  const row = await getSourceByCode('search_linkedin');
  if (!row || !row.isEnabled) return null;
  const serp = await getSourceByCode('serp_api');
  const provider = serp?.isEnabled && isSourceConfigured('serp_api') ? SEARCH_PROVIDERS.serp_api : SEARCH_PROVIDERS.ddg;
  return { provider, row };
}

// ── discover ─────────────────────────────────────────────────────────────────

async function discover(task: ClaimedTask): Promise<TaskOutcome> {
  const code = task.sourceCode as keyof typeof DISCOVERY_SOURCES | null;
  const source = code ? DISCOVERY_SOURCES[code] : undefined;
  const row = code ? await getSourceByCode(code) : null;
  if (!source || !row) throw new SourceUnavailableError(code ?? 'unknown', 'disabled');
  const query = task.payload.query as DiscoveryQuery;
  const targetPerRun = Number(task.payload.targetPerRun) || 20;
  const includePeople = task.payload.includePeople === true;
  const timezone = String(task.payload.timezone ?? 'Asia/Karachi');
  const found = await source.discover(query, createSourceContext(row));

  // Compliance: people/domains that asked to be removed are never collected again (UC-12).
  const kept: DiscoveredBusiness[] = [];
  for (const b of found) {
    if (await isDoNotCollect([{ type: 'domain', value: b.domain }, { type: 'email', value: b.email }])) continue;
    kept.push(b);
  }

  // A focus ("AI automation"): businesses whose name already says so become leads first.
  if (query.category && query.keywords.length) {
    kept.sort((a, b) => Number(!!matchFocus(query.keywords, b.name)) - Number(!!matchFocus(query.keywords, a.name)));
  }

  const ctx = ctxOf(task);
  const companyIds: number[] = [];
  let newCompanies = 0;
  for (const b of kept) {
    const r = await inTransaction((c) => upsertCompanyFromBusiness(c, b, ctx));
    companyIds.push(r.companyId);
    if (r.created) newCompanies++;
  }

  let added: number[] = [];
  let quotaHit = false;
  if (task.userId) {
    const res = await inTransaction((c) => addLeadsForRun(c, {
      runId: task.runId, userId: task.userId!, savedSearchId: task.savedSearchId, targetPerRun, timezone,
    }, companyIds));
    added = res.added;
    quotaHit = res.quotaHit;
    for (const id of added) await rescoreCompany(dbPool, id);
  }

  const sources = await listSources();
  const website = sources.find((s) => s.code === 'website' && s.isEnabled);
  const linkedin = sources.find((s) => s.code === 'search_linkedin' && s.isEnabled);
  const followUps: NewTask[] = [];
  if (added.length) {
    // A site crawled before topics were collected has no site_topics yet: crawl it again so a focus can match.
    const companies = await dbPool.query<{ id: number; website_url: string | null; fresh: boolean }>(
      `SELECT id, website_url,
              (last_enriched_at > now() - interval '${WEBSITE_REFRESH_DAYS} days' AND jsonb_array_length(site_topics) > 0) AS fresh
         FROM companies WHERE id = ANY($1)`,
      [added]
    );
    for (const c of companies.rows) {
      if (website && c.website_url && !c.fresh) {
        followUps.push({ taskType: 'fetch_site', target: c.website_url, sourceId: website.id, companyId: c.id, priority: task.priority, payload: { includePeople } });
      }
      if (linkedin) {
        followUps.push({ taskType: 'find_social', target: `company:${c.id}`, sourceId: linkedin.id, companyId: c.id, priority: task.priority, payload: { includePeople } });
      }
    }
  }
  return {
    stats: { discovered: kept.length, new_companies: newCompanies, new_leads: added.length, ...(quotaHit ? { quota_hit: 1 } : {}) },
    followUps,
    result: { count: kept.length, newLeads: added.length },
  };
}

// ── fetch_site ───────────────────────────────────────────────────────────────

async function websiteFetcher(): Promise<(url: string, opts?: Parameters<typeof safeFetch>[1]) => ReturnType<typeof safeFetch>> {
  const row = await getSourceByCode('website');
  return (url, opts) =>
    politeFetch(url, opts, {
      fetch: async (u, o) => {
        if (row) await recordSourceRequests(row.id);
        return safeFetch(u, o);
      },
      cacheGet,
      cacheSet,
    });
}

/** MX check of the company's (and its people's) unverified emails. */
async function verifyCompanyEmails(companyId: number): Promise<number> {
  const rows = await dbPool.query<{ id: number; value_normalized: string }>(
    `SELECT cp.id, cp.value_normalized FROM contact_points cp LEFT JOIN people p ON p.id = cp.person_id
      WHERE cp.type = 'email' AND cp.mx_valid IS NULL AND (cp.company_id = $1 OR p.current_company_id = $1)`,
    [companyId]
  );
  let checked = 0;
  for (const r of rows.rows) {
    const ok = await hasMx(r.value_normalized.split('@')[1]!);
    await dbPool.query(
      `UPDATE contact_points SET mx_valid = $2, verify_status = CASE WHEN verify_status = 'valid' THEN 'valid' WHEN $2 THEN 'valid' ELSE 'invalid' END, last_verified_at = now() WHERE id = $1`,
      [r.id, ok]
    );
    checked++;
  }
  return checked;
}

async function maybeProviderTask(task: ClaimedTask, companyId: number, tier: string | null): Promise<NewTask[]> {
  if (tier !== 'hot' || !pdlApiKey()) return [];
  const pdl = await getSourceByCode('pdl');
  if (!pdl?.isEnabled) return [];
  const d = await dbPool.query<{ primary_domain: string | null }>(`SELECT primary_domain FROM companies WHERE id = $1`, [companyId]);
  const domain = d.rows[0]?.primary_domain;
  return domain ? [{ taskType: 'provider_enrich', target: domain, sourceId: pdl.id, companyId, priority: task.priority }] : [];
}

async function fetchSite(task: ClaimedTask): Promise<TaskOutcome> {
  const companyId = task.companyId;
  if (!companyId) throw new FetchError('fetch_site without a company', 'bad_url');
  const prev = await dbPool.query<{ url: string; content_hash: string | null }>(`SELECT url, content_hash FROM web_pages WHERE company_id = $1`, [companyId]);
  const previousHashes = new Map(prev.rows.filter((r) => r.content_hash).map((r) => [r.url, r.content_hash!]));
  const crawl = await crawlSite(task.target, { fetch: await websiteFetcher(), previousHashes });
  const applied = await inTransaction((c) => applySiteFacts(c, companyId, crawl, ctxOf(task)));
  await verifyCompanyEmails(companyId);
  const tier = await rescoreCompany(dbPool, companyId);
  const followUps = await maybeProviderTask(task, companyId, tier);
  return {
    stats: { updated: 1, new_people: applied.newPeople, ...(crawl.status === 'down' ? { sites_down: 1 } : {}) },
    followUps,
    result: { status: crawl.status, pages: crawl.pages.length, unchanged: crawl.unchanged, emails: crawl.facts.emails.length, team: crawl.facts.team.length },
  };
}

// ── find_social ──────────────────────────────────────────────────────────────

async function findSocial(task: ClaimedTask): Promise<TaskOutcome> {
  const search = await linkedinSearch();
  if (!search) throw new SourceUnavailableError('search_linkedin', 'disabled');
  const ctx = createSourceContext(search.row);
  const rctx = ctxOf(task);

  // Refresh of one known person: job change check.
  if (task.target.startsWith('person:')) {
    const personId = Number(task.target.slice(7));
    const p = (await dbPool.query<{ linkedin_url: string | null; current_company_id: number | null }>(`SELECT linkedin_url, current_company_id FROM people WHERE id = $1 AND deleted_at IS NULL`, [personId])).rows[0];
    await dbPool.query(`UPDATE people SET next_refresh_at = now() + interval '60 days' WHERE id = $1`, [personId]);
    if (!p?.linkedin_url) return { stats: { updated: 1 } };
    const hit = await currentCompanyOf(p.linkedin_url, search.provider, ctx);
    if (!hit?.company) return { stats: { updated: 1 } };
    const current = p.current_company_id
      ? (await dbPool.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [p.current_company_id])).rows[0]?.name
      : null;
    if (current && companyNamesMatch(current, hit.company)) return { stats: { updated: 1 } };
    // Moved: the new employer must already be in the master data (we never invent companies from a title).
    const target = (await dbPool.query<{ id: number }>(
      `SELECT id FROM companies WHERE normalized_name = $1 AND deleted_at IS NULL ORDER BY data_quality DESC LIMIT 1`,
      [normalizeCompanyName(hit.company)]
    )).rows[0];
    if (target) {
      await inTransaction((c) => upsertPerson(c, target.id, { fullName: hit.fullName, title: hit.title, linkedinUrl: p.linkedin_url, foundVia: 'search_result', confidence: 50 }, rctx));
    }
    return { stats: { updated: 1 }, result: { jobChange: !!target } };
  }

  const companyId = task.companyId;
  if (!companyId) return { stats: {} };
  const company = (await dbPool.query<{ name: string; city: string | null }>(`SELECT name, city FROM companies WHERE id = $1 AND deleted_at IS NULL`, [companyId])).rows[0];
  if (!company) return { stats: {} };
  const hasLinkedin = (await dbPool.query(`SELECT 1 FROM social_profiles WHERE company_id = $1 AND platform = 'linkedin'`, [companyId])).rowCount;
  let found = 0;
  if (!hasLinkedin) {
    const page = await findCompanyLinkedin(company, search.provider, ctx);
    if (page && !(await isDoNotCollect([{ type: 'linkedin_url', value: page.url }]))) {
      await addSocial(dbPool, { companyId }, { platform: 'linkedin', url: page.url, foundVia: 'search_result', snippet: page.snippet });
      found++;
    }
  }
  let newPeople = 0;
  if (task.payload.includePeople === true) {
    for (const p of await findPeople(company, search.provider, ctx)) {
      const r = await inTransaction((c) => upsertPerson(c, companyId, { fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, sourceUrl: null, foundVia: 'search_result', confidence: 50 }, rctx));
      if (r?.created) newPeople++;
    }
  }
  const tier = await rescoreCompany(dbPool, companyId);
  return { stats: { new_people: newPeople }, followUps: await maybeProviderTask(task, companyId, tier), result: { linkedin: found, people: newPeople } };
}

// ── verify_email ─────────────────────────────────────────────────────────────

async function verifyEmail(task: ClaimedTask): Promise<TaskOutcome> {
  const id = Number(task.target.replace(/^contact:/, ''));
  const row = (await dbPool.query<{ value_normalized: string; company_id: number | null; person_id: number | null }>(
    `SELECT value_normalized, company_id, person_id FROM contact_points WHERE id = $1 AND type = 'email'`, [id]
  )).rows[0];
  if (!row) return { stats: {} };
  const ok = await hasMx(row.value_normalized.split('@')[1]!);
  await dbPool.query(
    `UPDATE contact_points SET mx_valid = $2, verify_status = CASE WHEN $2 THEN (CASE WHEN verify_status = 'invalid' THEN 'valid' ELSE verify_status END) ELSE 'invalid' END, last_verified_at = now() WHERE id = $1`,
    [id, ok]
  );
  const companyId = row.company_id ?? (row.person_id ? (await dbPool.query<{ c: number | null }>(`SELECT current_company_id AS c FROM people WHERE id = $1`, [row.person_id])).rows[0]?.c : null);
  if (companyId) await rescoreCompany(dbPool, companyId);
  return { stats: { updated: 1 } };
}

// ── provider_enrich ──────────────────────────────────────────────────────────

async function providerEnrich(task: ClaimedTask): Promise<TaskOutcome> {
  const row = await getSourceByCode('pdl');
  if (!row || !pdlApiKey()) throw new SourceUnavailableError('pdl', 'not_configured');
  const avail = await sourceAvailability(row);
  if (!avail.ok) throw new SourceUnavailableError('pdl', avail.reason);
  const companyId = task.companyId!;
  const res = await enrichWithProvider(task.target, createSourceContext(row));
  if (!res) return { stats: {} };
  const rctx = ctxOf(task);
  let newPeople = 0;
  await inTransaction(async (c) => {
    if (res.company) {
      await c.query(
        `UPDATE companies SET employee_range = COALESCE($2, employee_range), founded_year = COALESCE(founded_year, $3), industry = COALESCE(industry, $4) WHERE id = $1`,
        [companyId, res.company.employeeRange, res.company.foundedYear, res.company.industry]
      );
      if (res.company.linkedinUrl) await addSocial(c, { companyId }, { platform: 'linkedin', url: res.company.linkedinUrl, foundVia: 'provider' });
    }
    for (const p of res.people) {
      const r = await upsertPerson(c, companyId, { fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, email: p.workEmail, foundVia: 'provider', confidence: 80, emailVerified: !!p.workEmail }, rctx);
      if (r?.created) newPeople++;
    }
  });
  await verifyCompanyEmails(companyId);
  await rescoreCompany(dbPool, companyId);
  return { stats: { new_people: newPeople, updated: 1 } };
}

export const HANDLERS: Partial<Record<ScrapeTaskType, TaskHandler>> = {
  discover,
  fetch_site: fetchSite,
  find_social: findSocial,
  verify_email: verifyEmail,
  provider_enrich: providerEnrich,
};

/**
 * Turns a handler error into the task's next state. A block skips the task and puts the source on cooldown
 * (1 hour, or the rest of the day after too many blocks, with an admin bell).
 */
export async function handleTaskError(task: ClaimedTask, err: unknown): Promise<'retry' | 'failed' | 'skipped' | false> {
  if (err instanceof SourceBlockedError) {
    const row = await getSourceByCode(err.sourceCode);
    const sourceId = row?.id ?? task.sourceId;
    if (sourceId == null) return failTask(task, err.message, { retryable: true });
    const block = await recordSourceBlock(sourceId, err.retryAfterMs);
    if (block.offForToday && block.blockedToday === MAX_BLOCKS_PER_DAY) {
      await notifyAdmins('leadgen_source_blocked', {
        source: err.sourceCode, blockedToday: block.blockedToday,
        message: `Lead source ${err.sourceCode} was blocked ${block.blockedToday} times today and is off until tomorrow.`,
      });
    }
    // UC-03: the source cools down, the other sources keep going and the run ends 'partial'.
    // No retry inside this run: waiting an hour would hold one of the user's 2 run slots.
    return failTask(task, err.message, { retryable: false, skip: true });
  }
  if (err instanceof SourceUnavailableError) {
    return failTask(task, err.message, { retryable: false, skip: true });
  }
  if (err instanceof FetchError) {
    return failTask(task, err.message, { retryable: err.retryable, skip: !err.retryable });
  }
  const message = err instanceof Error ? err.message : String(err);
  return failTask(task, message, { retryable: true });
}
