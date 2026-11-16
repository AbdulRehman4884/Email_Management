/**
 * Run: LEADGEN_TEST_DATABASE_URL=postgres://.../leadgen_test npm run test:leadgen:db
 * THROWAWAY database only (lead engine tables are truncated). Skipped without LEADGEN_TEST_DATABASE_URL.
 *
 * Lead Engine Day 2/3 integration: API ownership + gating, quotas, pipeline end to end with fake sources
 * (no network), dedupe/merge, "only new leads" over a simulated 2-day schedule, save to CRM (conflict),
 * add to campaign (draft/paused only), opt-out end to end, nightly refresh, job change, purge.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DiscoveredBusiness, DiscoveryQuery } from '../leadgen/types.js';

const TEST_DB = process.env.LEADGEN_TEST_DATABASE_URL;
const skip = !TEST_DB ? 'set LEADGEN_TEST_DATABASE_URL to a throwaway database' : false;
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.LEADGEN_ENABLED = 'on';
  delete process.env.LEADGEN_SERP_API_KEY;
  delete process.env.LEADGEN_PDL_API_KEY;
}

let m: {
  db: typeof import('../db.js');
  queue: typeof import('../leadgen/taskQueue.js');
  sched: typeof import('../leadgen/scheduler.js');
  sources: typeof import('../leadgen/sources/index.js');
  worker: typeof import('../../workers/leadGenWorker.js');
  resolve: typeof import('../leadgen/resolve.js');
  crawler: typeof import('../leadgen/crawler.js');
  compliance: typeof import('../leadgen/compliance.js');
  refresh: typeof import('../leadgen/refresh.js');
  store: typeof import('../leadgen/leadStore.js');
};
let server: Server;
const sentMail: string[] = [];
let base = '';
const users = { admin: 0, on: 0, off: 0 };
const q = (sql: string, params: unknown[] = []) => m.db.dbPool.query(sql, params);

/** What the fake discovery sources return next (per source code). */
const fake: Record<string, DiscoveredBusiness[]> = { osm: [], ddg: [] };

function biz(name: string, opts: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness {
  return {
    sourceCode: 'osm', externalId: `osm:node/${name.toLowerCase().replace(/\W+/g, '-')}`, name, category: 'dentist',
    websiteUrl: null, domain: null, phone: null, email: null, address: null, city: 'Lahore', region: null, countryCode: 'PK',
    latitude: null, longitude: null, socials: [], sourceUrl: 'https://www.openstreetmap.org/node/1', confidence: 70, ...opts,
  };
}

async function api(method: string, path: string, user: number, body?: unknown, role = 'user') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': String(user), 'x-test-role': role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Runs every queued task to the end, like the worker loop, then closes finished runs. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await m.sched.startQueuedRuns();
    const tasks = await m.queue.claimTasks(20);
    if (tasks.length === 0) break;
    for (const t of tasks) await m.worker.processTask(t);
  }
  await m.sched.finalizeRuns();
}

async function runSearch(searchId: number, user = users.on): Promise<number> {
  const r = await api('POST', `/api/lead-gen/searches/${searchId}/run`, user);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await drain();
  return r.body.id;
}

before(async () => {
  if (skip) return;
  m = {
    db: await import('../db.js'),
    queue: await import('../leadgen/taskQueue.js'),
    sched: await import('../leadgen/scheduler.js'),
    sources: await import('../leadgen/sources/index.js'),
    worker: await import('../../workers/leadGenWorker.js'),
    resolve: await import('../leadgen/resolve.js'),
    crawler: await import('../leadgen/crawler.js'),
    compliance: await import('../leadgen/compliance.js'),
    refresh: await import('../leadgen/refresh.js'),
    store: await import('../leadgen/leadStore.js'),
  };
  // Fake discovery: no network in tests.
  for (const code of ['osm', 'ddg'] as const) {
    m.sources.DISCOVERY_SOURCES[code] = {
      code, type: code === 'osm' ? 'directory' : 'search',
      discover: async (query: DiscoveryQuery) => fake[code]!.slice(0, query.limit).map((b) => ({ ...b, sourceCode: code })),
    };
  }
  // Never send real email from tests.
  (await import('../../controllers/leadGenAdminController.js')).setPrivacyMailerForTests(async (o) => {
    sentMail.push(o.to);
    return 'test';
  });
  const express = (await import('express')).default;
  const { leadGenRouter, leadGenPublicRouter, requireLeadGen } = await import('../../routers/leadGenRouter.js');
  const app = express();
  app.use(express.json());
  app.use('/api', leadGenPublicRouter);
  app.use('/api/lead-gen', (req, _res, next) => {
    req.user = { id: Number(req.header('x-test-user')), email: 'x@test.local', role: req.header('x-test-role') ?? 'user' };
    next();
  }, requireLeadGen, leadGenRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const stamp = Date.now();
  await q(`INSERT INTO plans (code, name, smtp_limit, daily_email_limit, lead_gen_enabled, lead_gen_daily_limit) VALUES ('lgt_on', 'LG on', 1, 1, true, 50), ('lgt_off', 'LG off', 1, 1, false, 50) ON CONFLICT (code) DO UPDATE SET lead_gen_enabled = EXCLUDED.lead_gen_enabled, lead_gen_daily_limit = 50`);
  const mk = async (tag: string, role: string, plan: string | null) => {
    const idv = (await q(`INSERT INTO users (email, password_hash, name, role) VALUES ($1, 'x', $2, $3) RETURNING id`, [`lg-${tag}-${stamp}@test.local`, `LG ${tag}`, role])).rows[0].id;
    if (plan) await q(`INSERT INTO subscriptions (user_id, plan_code, status) VALUES ($1, $2, 'active')`, [idv, plan]);
    return idv as number;
  };
  users.admin = await mk('admin', 'admin', null);
  users.on = await mk('on', 'user', 'lgt_on');
  users.off = await mk('off', 'user', 'lgt_off');
});

beforeEach(async () => {
  if (skip) return;
  process.env.LEADGEN_ENABLED = 'on';
  fake.osm = [];
  fake.ddg = [];
  await q(`TRUNCATE scrape_tasks, scrape_runs, search_schedules, saved_searches, workspace_leads, companies, people, observations,
           source_daily_usage, leadgen_cache, do_not_collect, data_subject_requests, entity_merges CASCADE`);
  // Discovery only (website crawl / LinkedIn need the network; they are tested with fakes below).
  await q(`UPDATE sources SET cooldown_until = NULL, is_enabled = code IN ('osm', 'ddg')`);
  await q(`UPDATE plans SET lead_gen_daily_limit = 50 WHERE code = 'lgt_on'`);
  const ids = [users.admin, users.on, users.off];
  await q(`DELETE FROM crm_stage_history WHERE contact_id IN (SELECT id FROM crm_contacts WHERE user_id = ANY($1))`, [ids]);
  await q(`DELETE FROM crm_contacts WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM recipients WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = ANY($1))`, [ids]);
  await q(`DELETE FROM campaigns WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM user_notifications WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM suppression_list WHERE email LIKE '%@lgtest.pk'`);
});

after(async () => {
  if (skip) return;
  server?.close();
  const ids = [users.admin, users.on, users.off];
  await q(`TRUNCATE scrape_tasks, scrape_runs, search_schedules, saved_searches, workspace_leads, companies, people, observations CASCADE`);
  await q(`DELETE FROM crm_stage_history WHERE contact_id IN (SELECT id FROM crm_contacts WHERE user_id = ANY($1))`, [ids]);
  await q(`DELETE FROM crm_contacts WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM crm_pipeline_stages WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM crm_pipelines WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM recipients WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = ANY($1))`, [ids]);
  await q(`DELETE FROM campaigns WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM user_notifications WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM subscriptions WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
  await q(`DELETE FROM plans WHERE code IN ('lgt_on', 'lgt_off')`);
  await m.db.dbPool.end();
});

const createSearch = async (body: object = { category: 'dental clinics', city: 'lahore', countryCode: 'pk' }, user = users.on) => {
  const r = await api('POST', '/api/lead-gen/searches', user, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

// ── Gating + ownership ───────────────────────────────────────────────────────

test('LEADGEN_ENABLED off = 404, admin mode = admins only, on = plan flag (403 otherwise)', { skip }, async () => {
  process.env.LEADGEN_ENABLED = 'off';
  assert.equal((await api('GET', '/api/lead-gen/searches', users.admin, undefined, 'admin')).status, 404);
  process.env.LEADGEN_ENABLED = 'admin';
  assert.equal((await api('GET', '/api/lead-gen/searches', users.on)).status, 404);
  assert.equal((await api('GET', '/api/lead-gen/searches', users.admin, undefined, 'admin')).status, 200);
  process.env.LEADGEN_ENABLED = 'on';
  assert.equal((await api('GET', '/api/lead-gen/searches', users.on)).status, 200);
  const off = await api('GET', '/api/lead-gen/searches', users.off);
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'PLAN_FEATURE_REQUIRED');
});

test('create search: category words resolve, default name; validation; other users get 404 everywhere', { skip }, async () => {
  const s = await createSearch();
  assert.equal(s.category, 'dentist');
  assert.equal(s.name, 'Dental clinics in Lahore');
  assert.equal(s.countryCode, 'PK');
  const kw = await createSearch({ category: 'solar installers', city: 'Karachi' });
  assert.equal(kw.category, null);
  assert.deepEqual(kw.keywords, ['solar installers']);
  assert.equal((await api('POST', '/api/lead-gen/searches', users.on, { city: 'Lahore' })).status, 400);
  assert.equal((await api('POST', '/api/lead-gen/searches', users.on, { category: 'dentist', city: 'Lahore', targetPerRun: 500 })).status, 400);

  const other = users.admin;
  for (const [method, path, body] of [
    ['PATCH', `/api/lead-gen/searches/${s.id}`, { name: 'x' }],
    ['POST', `/api/lead-gen/searches/${s.id}/run`, undefined],
    ['POST', `/api/lead-gen/searches/${s.id}/schedule`, { runAtLocal: '09:00' }],
    ['DELETE', `/api/lead-gen/searches/${s.id}`, undefined],
  ] as const) {
    assert.equal((await api(method, path, other, body, 'admin')).status, 404, `${method} ${path}`);
  }
  assert.equal((await api('GET', '/api/lead-gen/searches', other, undefined, 'admin')).body.searches.length, 0);
});

test('max 10 active searches; usage endpoint shows quota', { skip }, async () => {
  for (let i = 0; i < 10; i++) await createSearch({ category: 'dentist', city: `City${i}` });
  const r = await api('POST', '/api/lead-gen/searches', users.on, { category: 'dentist', city: 'Extra' });
  assert.equal(r.status, 429);
  const usage = await api('GET', '/api/lead-gen/usage', users.on);
  assert.deepEqual([usage.body.activeSearches, usage.body.maxSearches, usage.body.dailyLimit], [10, 10, 50]);
});

test('schedule: create, pause, resume (next run recomputed), one schedule per search', { skip }, async () => {
  const s = await createSearch();
  const sch = await api('POST', `/api/lead-gen/searches/${s.id}/schedule`, users.on, { runAtLocal: '9:00', timezone: 'Asia/Karachi' });
  assert.equal(sch.status, 200);
  assert.equal(sch.body.runAtLocal, '09:00');
  assert.ok(new Date(sch.body.nextRunAt) > new Date());
  const again = await api('POST', `/api/lead-gen/searches/${s.id}/schedule`, users.on, { runAtLocal: '10:30', frequency: 'weekly', weekdays: ['mon', 'wed'] });
  assert.equal(again.body.id, sch.body.id, 'same schedule updated');
  assert.deepEqual(again.body.weekdays, ['mon', 'wed']);
  const paused = await api('PATCH', `/api/lead-gen/schedules/${sch.body.id}`, users.on, { isPaused: true });
  assert.equal(paused.body.isPaused, true);
  const resumed = await api('PATCH', `/api/lead-gen/schedules/${sch.body.id}`, users.on, { isPaused: false });
  assert.equal(resumed.body.isPaused, false);
  assert.equal((await api('PATCH', `/api/lead-gen/schedules/${sch.body.id}`, users.admin, { isPaused: true }, 'admin')).status, 404);
  assert.equal((await api('POST', `/api/lead-gen/searches/${s.id}/schedule`, users.on, { runAtLocal: '25:00' })).status, 400);
});

// ── Pipeline ─────────────────────────────────────────────────────────────────

test('run now: businesses become companies and NEW workspace leads (target per run), scored; bell at the end', { skip }, async () => {
  fake.osm = [
    biz('Smile Dental', { phone: '042 3577 1234', email: 'info@smile.lgtest.pk', websiteUrl: 'https://smile.lgtest.pk', domain: 'smile.lgtest.pk' }),
    biz('City Dentists', { phone: '0300 1234567' }),
    biz('Bright Teeth'),
  ];
  const s = await createSearch({ category: 'dentist', city: 'Lahore', targetPerRun: 2 });
  const runId = await runSearch(s.id);
  const run = (await api('GET', `/api/lead-gen/runs/${runId}`, users.on)).body;
  assert.equal(run.status, 'done');
  assert.equal(run.stats.new_leads, 2);
  assert.equal(run.stats.discovered, 3);
  const leads = (await api('GET', '/api/lead-gen/leads', users.on)).body;
  assert.equal(leads.total, 2);
  const smile = leads.leads.find((l: { company: { name: string } }) => l.company.name === 'Smile Dental');
  assert.equal(smile.company.phone, '+924235771234');
  assert.equal(smile.company.email, 'info@smile.lgtest.pk');
  assert.ok(smile.fitScore > 0);
  const detail = (await api('GET', `/api/lead-gen/leads/${smile.id}`, users.on)).body;
  assert.ok(detail.fieldSources.some((f: { field: string; source: string }) => f.field === 'phone' && f.source === 'osm'), 'phone source shown');
  assert.ok(detail.lead.scoreBreakdown.some((b: { key: string }) => b.key === 'categoryMatch'));
  assert.equal((await api('GET', `/api/lead-gen/leads/${smile.id}`, users.admin, undefined, 'admin')).status, 404);
  const bell = (await q(`SELECT payload FROM user_notifications WHERE user_id = $1 AND type = 'leadgen_run_done'`, [users.on])).rows;
  assert.match(bell[0].payload.message, /2 new leads/);
});

test('same company from 2 sources = 1 record (domain), and from the same source id twice = 1 record', { skip }, async () => {
  fake.osm = [biz('Acme Dental Clinic', { websiteUrl: 'https://www.acme.lgtest.pk', domain: 'acme.lgtest.pk', phone: '042 3577 0000' })];
  fake.ddg = [biz('Acme Dental | Best Dentist', { sourceCode: 'ddg', externalId: 'web:acme.lgtest.pk', websiteUrl: 'https://acme.lgtest.pk/', domain: 'acme.lgtest.pk' })];
  const s = await createSearch();
  await runSearch(s.id);
  await runSearch(s.id);
  assert.equal((await q(`SELECT count(*)::int AS n FROM companies WHERE deleted_at IS NULL`)).rows[0].n, 1);
  assert.equal((await q(`SELECT count(*)::int AS n FROM workspace_leads`)).rows[0].n, 1);
});

test('simulated 2-day schedule: the second day gives only new leads', { skip }, async () => {
  const s = await createSearch({ category: 'dentist', city: 'Lahore', targetPerRun: 20 });
  const sch = (await api('POST', `/api/lead-gen/searches/${s.id}/schedule`, users.on, { runAtLocal: '09:00' })).body;
  fake.osm = ['A Dental', 'B Dental', 'C Dental'].map((n) => biz(n));
  // Day 1: the slot is due.
  await q(`UPDATE search_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [sch.id]);
  assert.equal((await m.sched.tickScheduler()).created, 1);
  await drain();
  // Day 2: the same three plus two new ones.
  fake.osm = ['A Dental', 'B Dental', 'C Dental', 'D Dental', 'E Dental'].map((n) => biz(n));
  await q(`UPDATE scrape_runs SET run_date = run_date - 1, created_at = created_at - interval '1 day'`);
  await q(`UPDATE workspace_leads SET found_at = found_at - interval '1 day'`);
  await q(`UPDATE search_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [sch.id]);
  assert.equal((await m.sched.tickScheduler()).created, 1);
  await drain();
  const runs = (await q(`SELECT stats FROM scrape_runs WHERE schedule_id = $1 ORDER BY id`, [sch.id])).rows.map((r) => r.stats.new_leads);
  assert.deepEqual(runs, [3, 2]);
  const today = (await api('GET', '/api/lead-gen/leads?foundToday=1', users.on)).body;
  assert.deepEqual(today.leads.map((l: { company: { name: string } }) => l.company.name).sort(), ['D Dental', 'E Dental']);
});

test('daily quota: the run stops at the limit and ends partial', { skip }, async () => {
  await q(`UPDATE plans SET lead_gen_daily_limit = 3 WHERE code = 'lgt_on'`);
  fake.osm = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map((n) => biz(`${n} Dental`));
  const s = await createSearch();
  const runId = await runSearch(s.id);
  const run = (await api('GET', `/api/lead-gen/runs/${runId}`, users.on)).body;
  assert.equal(run.stats.new_leads, 3);
  assert.equal(run.status, 'partial');
  assert.match(run.error, /limit/);
  const again = await api('POST', `/api/lead-gen/searches/${s.id}/run`, users.on);
  assert.equal(again.status, 429);
});

test('max 2 runs at once per user (run now answers 429)', { skip }, async () => {
  const s = await createSearch();
  await q(`INSERT INTO scrape_runs (user_id, saved_search_id, run_date, run_type, status) VALUES ($1, $2, current_date, 'manual', 'running'), ($1, $2, current_date, 'manual', 'queued')`, [users.on, s.id]);
  assert.equal((await api('POST', `/api/lead-gen/searches/${s.id}/run`, users.on)).status, 429);
});

test('reject: the lead is hidden and never comes back', { skip }, async () => {
  fake.osm = [biz('Reject Me Dental')];
  const s = await createSearch();
  await runSearch(s.id);
  const lead = (await api('GET', '/api/lead-gen/leads', users.on)).body.leads[0];
  assert.equal((await api('POST', '/api/lead-gen/leads/reject', users.on, { leadIds: [lead.id] })).body.updated, 1);
  assert.equal((await api('GET', '/api/lead-gen/leads', users.on)).body.total, 0);
  await runSearch(s.id);
  assert.equal((await api('GET', '/api/lead-gen/leads', users.on)).body.total, 0);
  assert.equal((await api('GET', '/api/lead-gen/leads?status=rejected', users.on)).body.total, 1);
});

// ── Resolution ───────────────────────────────────────────────────────────────

test('two existing records found to share a domain are merged; the better workspace status survives', { skip }, async () => {
  const ctx = { runId: null, sourceId: null };
  const a = await m.resolve.inTransaction((c) => m.resolve.upsertCompanyFromBusiness(c, biz('Old Name Clinic', { externalId: 'osm:node/a' }), ctx));
  const b = await m.resolve.inTransaction((c) => m.resolve.upsertCompanyFromBusiness(c, biz('New Name Clinic', { externalId: 'osm:node/b', websiteUrl: 'https://merge.lgtest.pk', domain: 'merge.lgtest.pk' }), ctx));
  assert.notEqual(a.companyId, b.companyId);
  await q(`INSERT INTO workspace_leads (user_id, company_id, status) VALUES ($1, $2, 'saved_to_crm'), ($1, $3, 'new')`, [users.on, a.companyId, b.companyId]);
  // Company A is seen again, now with B's domain: one business.
  const again = await m.resolve.inTransaction((c) => m.resolve.upsertCompanyFromBusiness(c, biz('Old Name Clinic', { externalId: 'osm:node/a', domain: 'merge.lgtest.pk', websiteUrl: 'https://merge.lgtest.pk' }), ctx));
  assert.equal(again.companyId, Math.min(a.companyId, b.companyId));
  assert.equal((await q(`SELECT count(*)::int AS n FROM companies WHERE deleted_at IS NULL`)).rows[0].n, 1);
  const leads = (await q(`SELECT status FROM workspace_leads WHERE user_id = $1`, [users.on])).rows;
  assert.deepEqual(leads.map((l) => l.status), ['saved_to_crm']);
  assert.equal((await q(`SELECT reason FROM entity_merges`)).rows[0].reason, 'same_domain');
});

test('website facts: contact points, socials, team -> people; decision maker raises the score; hash skips', { skip }, async () => {
  fake.osm = [biz('Crawl Dental', { websiteUrl: 'https://crawl.lgtest.pk/', domain: 'crawl.lgtest.pk' })];
  const s = await createSearch();
  await runSearch(s.id);
  const company = (await q(`SELECT id FROM companies WHERE primary_domain = 'crawl.lgtest.pk'`)).rows[0].id;
  const before = (await q(`SELECT fit_score FROM workspace_leads WHERE company_id = $1`, [company])).rows[0].fit_score;
  const home = `<html><body><a href="mailto:ali@crawl.lgtest.pk">mail</a><a href="https://www.linkedin.com/company/crawl-dental">in</a>
    <div class="team-member"><h3>Ali Raza</h3><p>Founder &amp; CEO</p></div></body></html>`;
  const fetchFake = async (url: string) => url === 'https://crawl.lgtest.pk/'
    ? { url, status: 200, headers: {}, body: home, redirects: [] }
    : { url, status: 404, headers: {}, body: '', redirects: [] };
  const crawl = await m.crawler.crawlSite('https://crawl.lgtest.pk/', { fetch: fetchFake });
  await m.resolve.inTransaction((c) => m.resolve.applySiteFacts(c, company, crawl, { runId: null, sourceId: null }));
  await q(`UPDATE contact_points SET mx_valid = true, verify_status = 'valid' WHERE company_id = $1`, [company]);
  await m.resolve.rescoreCompany(m.db.dbPool, company);
  const after = (await q(`SELECT fit_score, score_tier FROM workspace_leads WHERE company_id = $1`, [company])).rows[0];
  assert.ok(after.fit_score > before, `${after.fit_score} > ${before}`);
  const person = (await q(`SELECT full_name, seniority FROM people WHERE current_company_id = $1`, [company])).rows[0];
  assert.deepEqual(person, { full_name: 'Ali Raza', seniority: 'owner' });
  const lead = (await api('GET', '/api/lead-gen/leads?hasDecisionMaker=1', users.on)).body.leads[0];
  assert.equal(lead.person.fullName, 'Ali Raza');
  const pages = (await q(`SELECT content_hash FROM web_pages WHERE company_id = $1 AND page_type = 'home'`, [company])).rows[0];
  const again = await m.crawler.crawlSite('https://crawl.lgtest.pk/', { fetch: fetchFake, previousHashes: new Map([['https://crawl.lgtest.pk/', pages.content_hash]]) });
  assert.equal(again.unchanged, true);
});

test('job change: a known LinkedIn profile at another company ends the old employment and alerts CRM owners', { skip }, async () => {
  const ctx = { runId: null, sourceId: null };
  const a = await m.resolve.inTransaction((c) => m.resolve.upsertCompanyFromBusiness(c, biz('First Co', { externalId: 'x:1' }), ctx));
  const b = await m.resolve.inTransaction((c) => m.resolve.upsertCompanyFromBusiness(c, biz('Second Co', { externalId: 'x:2' }), ctx));
  await m.resolve.inTransaction((c) => m.resolve.upsertPerson(c, a.companyId, { fullName: 'Sara Khan', title: 'CEO', linkedinUrl: 'https://www.linkedin.com/in/sara-khan', email: 'sara@first.lgtest.pk', foundVia: 'website_link', confidence: 60 }, ctx));
  await q(`INSERT INTO crm_contacts (user_id, email) VALUES ($1, 'sara@first.lgtest.pk')`, [users.on]);
  const moved = await m.resolve.inTransaction((c) => m.resolve.upsertPerson(c, b.companyId, { fullName: 'Sara Khan', title: 'Director', linkedinUrl: 'https://www.linkedin.com/in/sara-khan', foundVia: 'search_result', confidence: 50 }, ctx));
  assert.equal(moved?.jobChange, true);
  const jobs = (await q(`SELECT company_id, is_current FROM employments WHERE person_id = $1 ORDER BY id`, [moved!.personId])).rows;
  assert.deepEqual(jobs, [{ company_id: a.companyId, is_current: false }, { company_id: b.companyId, is_current: true }]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND type = 'leadgen_job_change'`, [users.on])).rows[0].n, 1);
});

// ── CRM / campaign ───────────────────────────────────────────────────────────

test('save to CRM: upsert ON CONFLICT keeps the existing CRM lead; no-email leads are skipped', { skip }, async () => {
  fake.osm = [biz('Mail Dental', { email: 'hello@mail.lgtest.pk' }), biz('No Mail Dental')];
  const s = await createSearch();
  await runSearch(s.id);
  await q(`INSERT INTO crm_contacts (user_id, email, name) VALUES ($1, 'hello@mail.lgtest.pk', 'Existing Name')`, [users.on]);
  const ids = (await api('GET', '/api/lead-gen/leads', users.on)).body.leads.map((l: { id: number }) => l.id);
  const r = await api('POST', '/api/lead-gen/leads/save-to-crm', users.on, { leadIds: ids });
  assert.deepEqual(r.body, { saved: 0, updated: 1, skippedNoEmail: 1, skippedSuppressed: 0 });
  const c = (await q(`SELECT name, company FROM crm_contacts WHERE user_id = $1`, [users.on])).rows;
  assert.deepEqual(c, [{ name: 'Existing Name', company: 'Mail Dental' }]);
  const statuses = (await q(`SELECT status FROM workspace_leads WHERE user_id = $1 ORDER BY status`, [users.on])).rows.map((x) => x.status);
  assert.deepEqual(statuses, ['new', 'saved_to_crm']);
  // Another user's lead ids do nothing.
  assert.deepEqual((await api('POST', '/api/lead-gen/leads/save-to-crm', users.admin, { leadIds: ids }, 'admin')).body.saved, 0);
});

test('add to campaign: draft/paused only, MX-valid emails only, no duplicates', { skip }, async () => {
  fake.osm = [biz('Camp One', { email: 'one@camp.lgtest.pk' }), biz('Camp Two', { email: 'two@camp.lgtest.pk' })];
  const s = await createSearch();
  await runSearch(s.id);
  await q(`UPDATE contact_points SET mx_valid = (value_normalized = 'one@camp.lgtest.pk')`);
  const mkCampaign = async (status: string) => (await q(
    `INSERT INTO campaigns (user_id, name, status, subject, email_content, from_name, from_email) VALUES ($1, 'C', $2, 's', 'b', 'f', 'f@x.com') RETURNING id`,
    [users.on, status]
  )).rows[0].id as number;
  const draft = await mkCampaign('draft');
  const running = await mkCampaign('in_progress');
  const ids = (await api('GET', '/api/lead-gen/leads', users.on)).body.leads.map((l: { id: number }) => l.id);
  assert.equal((await api('POST', '/api/lead-gen/leads/add-to-campaign', users.on, { leadIds: ids, campaignId: running })).status, 409);
  const r = await api('POST', '/api/lead-gen/leads/add-to-campaign', users.on, { leadIds: ids, campaignId: draft });
  assert.deepEqual(r.body, { campaignId: draft, added: 1, skippedNoEmail: 1, skippedDuplicate: 0, skippedSuppressed: 0 });
  const twice = await api('POST', '/api/lead-gen/leads/add-to-campaign', users.on, { leadIds: ids, campaignId: draft });
  assert.equal(twice.body.added, 0);
  assert.equal((await q(`SELECT reciept_count FROM campaigns WHERE id = $1`, [draft])).rows[0].reciept_count, 1);
  assert.equal((await api('POST', '/api/lead-gen/leads/add-to-campaign', users.admin, { leadIds: ids, campaignId: draft }, 'admin')).status, 404);
});

// ── Compliance ───────────────────────────────────────────────────────────────

test('opt-out end to end: confirmed erasure deletes the person, suppresses the email, and the next run never brings it back', { skip }, async () => {
  fake.osm = [biz('Erase Dental', { email: 'owner@erase.lgtest.pk', websiteUrl: 'https://erase.lgtest.pk', domain: 'erase.lgtest.pk' })];
  const s = await createSearch();
  await runSearch(s.id);
  const company = (await q(`SELECT id FROM companies WHERE primary_domain = 'erase.lgtest.pk'`)).rows[0].id;
  await m.resolve.inTransaction((c) => m.resolve.upsertPerson(c, company, { fullName: 'Owner Person', title: 'Owner', linkedinUrl: 'https://www.linkedin.com/in/owner-person', email: 'owner@erase.lgtest.pk', foundVia: 'website_link', confidence: 60 }, { runId: null, sourceId: null }));

  const req = await fetch(`${base}/api/lead-gen/privacy/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'Owner@Erase.lgtest.pk' }) });
  assert.equal(req.status, 202);
  assert.deepEqual(sentMail, ['Owner@Erase.lgtest.pk'], 'confirmation link goes to that email (stubbed)');
  const stored = (await q(`SELECT identifier_hash FROM data_subject_requests`)).rows[0].identifier_hash;
  assert.doesNotMatch(stored, /erase/, 'only the hash is stored');
  // The emailed link (token) cannot be read back from the database: create a request directly to get one.
  const created = await m.compliance.createSubjectRequest('erasure', 'email', 'owner@erase.lgtest.pk');
  const bad = await fetch(`${base}/api/lead-gen/privacy/verify?id=${created!.id}&token=wrong&email=owner@erase.lgtest.pk`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`${base}/api/lead-gen/privacy/verify?id=${created!.id}&token=${created!.token}&email=owner@erase.lgtest.pk`);
  assert.equal(ok.status, 200);
  assert.equal((await q(`SELECT count(*)::int AS n FROM people`)).rows[0].n, 0);
  assert.equal((await q(`SELECT count(*)::int AS n FROM contact_points WHERE value_normalized = 'owner@erase.lgtest.pk'`)).rows[0].n, 0);
  assert.equal((await q(`SELECT count(*)::int AS n FROM suppression_list WHERE email = 'owner@erase.lgtest.pk'`)).rows[0].n, 1);
  // Used link: not valid twice.
  assert.equal((await fetch(`${base}/api/lead-gen/privacy/verify?id=${created!.id}&token=${created!.token}&email=owner@erase.lgtest.pk`)).status, 400);

  // Next run finds the same business with the same email: the email is not collected again.
  await runSearch(s.id);
  assert.equal((await q(`SELECT count(*)::int AS n FROM contact_points WHERE value_normalized = 'owner@erase.lgtest.pk'`)).rows[0].n, 0);
  // A person with that email is refused too.
  const again = await m.resolve.inTransaction((c) => m.resolve.upsertPerson(c, company, { fullName: 'Owner Person', title: 'Owner', linkedinUrl: null, email: 'owner@erase.lgtest.pk', foundVia: 'website_link', confidence: 60 }, { runId: null, sourceId: null }));
  assert.equal(again, null);
});

test('domain opt-out (admin checked): the company leaves every workspace and is not collected again', { skip }, async () => {
  fake.osm = [biz('Gone Co', { websiteUrl: 'https://gone.lgtest.pk', domain: 'gone.lgtest.pk' })];
  const s = await createSearch();
  await runSearch(s.id);
  const created = await m.compliance.createSubjectRequest('opt_out', 'domain', 'gone.lgtest.pk');
  assert.equal(created?.needsAdmin, true);
  assert.equal(await m.compliance.processByAdmin(created!.id, 'other.lgtest.pk'), null, 'wrong identifier');
  const res = await m.compliance.processByAdmin(created!.id, 'https://www.gone.lgtest.pk/');
  assert.equal(res?.companies, 1);
  await runSearch(s.id);
  assert.equal((await q(`SELECT count(*)::int AS n FROM companies WHERE primary_domain = 'gone.lgtest.pk'`)).rows[0].n, 0);
  assert.equal((await api('GET', '/api/lead-gen/leads', users.on)).body.total, 0);
});

// ── Refresh / purge ──────────────────────────────────────────────────────────

test('nightly refresh: one run per night with fetch_site for due companies in use; outside the window nothing', { skip }, async () => {
  await q(`UPDATE sources SET is_enabled = true WHERE code = 'website'`);
  fake.osm = [biz('Due Dental', { websiteUrl: 'https://due.lgtest.pk', domain: 'due.lgtest.pk' })];
  const s = await createSearch();
  await q(`UPDATE sources SET is_enabled = false WHERE code = 'website'`);
  await runSearch(s.id);
  await q(`UPDATE sources SET is_enabled = true WHERE code = 'website'`);
  await q(`UPDATE companies SET next_refresh_at = now() - interval '1 day'`);
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  assert.equal(await m.refresh.startNightlyRefresh(noon), null);
  const night = new Date();
  night.setHours(2, 0, 0, 0);
  const runId = await m.refresh.startNightlyRefresh(night);
  assert.ok(runId);
  assert.equal(await m.refresh.startNightlyRefresh(night), null, 'one refresh run per night');
  const tasks = (await q(`SELECT task_type, priority FROM scrape_tasks WHERE run_id = $1`, [runId])).rows;
  assert.deepEqual(tasks.map((t) => t.task_type), ['fetch_site']);
  assert.equal(tasks[0].priority, 0, 'below user runs');
});

test('purge: old observations go; unused old companies are deleted; companies in a workspace stay', { skip }, async () => {
  const ctx = { runId: null, sourceId: null };
  const used = await m.resolve.inTransaction((c) => m.resolve.upsertCompanyFromBusiness(c, biz('Used Co', { externalId: 'p:1' }), ctx));
  const unused = await m.resolve.inTransaction((c) => m.resolve.upsertCompanyFromBusiness(c, biz('Unused Co', { externalId: 'p:2' }), ctx));
  await q(`INSERT INTO workspace_leads (user_id, company_id) VALUES ($1, $2)`, [users.on, used.companyId]);
  await q(`UPDATE companies SET first_seen_at = now() - interval '400 days'`);
  await q(`UPDATE observations SET observed_at = now() - interval '400 days'`);
  const r = await m.refresh.purgeOldData();
  assert.ok(r.observations > 0);
  const left = (await q(`SELECT name FROM companies ORDER BY name`)).rows.map((x) => x.name);
  assert.deepEqual(left, ['Used Co']);
  void unused;
});

test('focus: "IT companies working on AI automation" = category + focus; matching leads score higher and can be filtered', { skip }, async () => {
  const s = await createSearch({ category: 'IT companies working on AI automation', city: 'Lahore', countryCode: 'PK' });
  assert.equal(s.category, 'it_company');
  assert.deepEqual(s.keywords, ['AI automation']);
  const withFocus = await createSearch({ category: 'it_company', focus: 'chatbots, RPA', city: 'Karachi' });
  assert.deepEqual(withFocus.keywords, ['chatbots', 'RPA']);

  fake.osm = [biz('Plain Web Studio', { category: 'it_company' }), biz('Lahore AI Automation Labs', { category: 'it_company' })];
  await runSearch(s.id);
  const all = (await api('GET', '/api/lead-gen/leads', users.on)).body;
  assert.equal(all.total, 2);
  const top = all.leads[0];
  assert.equal(top.company.name, 'Lahore AI Automation Labs', 'the focus match comes first');
  assert.equal(top.focusMatch, 'AI automation');
  const only = (await api('GET', '/api/lead-gen/leads?matchesFocus=1', users.on)).body;
  assert.deepEqual(only.leads.map((l: { company: { name: string } }) => l.company.name), ['Lahore AI Automation Labs']);
  // Website topics count too: the other company's site says it does automation with AI.
  const plain = all.leads.find((l: { company: { name: string } }) => l.company.name === 'Plain Web Studio');
  await q(`UPDATE companies SET site_topics = '["Business automation with AI"]'::jsonb WHERE id = $1`, [plain.company.id]);
  await m.resolve.rescoreCompany(m.db.dbPool, plain.company.id);
  assert.equal((await api('GET', '/api/lead-gen/leads?matchesFocus=1', users.on)).body.total, 2);
  // Changing the focus: the search keeps its category.
  const upd = await api('PATCH', `/api/lead-gen/searches/${s.id}`, users.on, { focus: 'computer vision' });
  assert.deepEqual(upd.body.keywords, ['computer vision']);
});
