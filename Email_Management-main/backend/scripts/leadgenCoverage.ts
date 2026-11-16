/**
 * Real-data coverage run (Lead Engine plan, Day 3): runs saved searches end to end against the real internet
 * (OSM + company websites, robots.txt and rate limits respected) and writes a field coverage report.
 *
 *   DATABASE_URL=<throwaway db> npx tsx scripts/leadgenCoverage.ts "dentist|Lahore|PK" "real_estate|Dubai|AE" "lawyer|London|GB"
 *   options: --target=100 --concurrency=8 --out=../docs/lead-engine-coverage.md
 *
 * Uses a dedicated user "leadgen-coverage@local" on a plan with a large daily limit. Never point it at production.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dbPool } from '../src/lib/db.js';
import { startRun, finalizeRuns } from '../src/lib/leadgen/scheduler.js';
import { claimTasks } from '../src/lib/leadgen/taskQueue.js';
import { processTask } from '../src/workers/leadGenWorker.js';
import { getCategory } from '../src/lib/leadgen/categories.js';

process.env.LEADGEN_ENABLED = 'on';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, def: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const TARGET = Number(opt('target', '100'));
const CONCURRENCY = Number(opt('concurrency', '8'));
const OUT = path.resolve(__dirname, opt('out', '../../docs/lead-engine-coverage.md'));
const niches = args.filter((a) => !a.startsWith('--')).map((a) => {
  const [category, city, country] = a.split('|');
  return { category: category!, city: city!, country: country ?? null };
});

async function setupUser(): Promise<number> {
  await dbPool.query(
    `INSERT INTO plans (code, name, smtp_limit, daily_email_limit, lead_gen_enabled, lead_gen_daily_limit)
     VALUES ('lg_coverage', 'Coverage run', 1, 1, true, 10000) ON CONFLICT (code) DO UPDATE SET lead_gen_enabled = true, lead_gen_daily_limit = 10000`
  );
  const u = await dbPool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash, name, role) VALUES ('leadgen-coverage@local', 'x', 'Coverage', 'user')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`
  );
  const id = u.rows[0]!.id;
  await dbPool.query(`INSERT INTO subscriptions (user_id, plan_code, status) VALUES ($1, 'lg_coverage', 'active') ON CONFLICT (user_id) DO UPDATE SET plan_code = 'lg_coverage', status = 'active'`, [id]);
  return id;
}

async function drain(): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  let idleRounds = 0;
  const started = Date.now();
  for (;;) {
    const free = CONCURRENCY - inFlight.size;
    const tasks = free > 0 ? await claimTasks(free) : [];
    for (const t of tasks) {
      const p = processTask(t).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    if (tasks.length === 0 && inFlight.size === 0) {
      await finalizeRuns();
      // Retries wait for their backoff (1, 5, 30 minutes): keep waiting up to 40 minutes, not just a minute.
      const open = await dbPool.query(`SELECT count(*)::int AS n FROM scrape_tasks WHERE status IN ('pending', 'running')`);
      if (open.rows[0].n === 0 || ++idleRounds > 1200) break;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    idleRounds = 0;
    if (inFlight.size >= CONCURRENCY || tasks.length === 0) await Promise.race(inFlight);
    if ((Date.now() - started) % 30_000 < 500) {
      const s = await dbPool.query(`SELECT status, count(*)::int AS n FROM scrape_tasks GROUP BY status`);
      console.log(`  tasks: ${s.rows.map((r) => `${r.status} ${r.n}`).join(', ')}`);
    }
  }
  await finalizeRuns();
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');

async function coverage(userId: number, searchId: number) {
  const r = await dbPool.query(
    `WITH l AS (SELECT w.*, c.website_url, c.status AS cstatus, c.last_enriched_at, c.tech_stack, c.hiring_signals, c.description
                  FROM workspace_leads w JOIN companies c ON c.id = w.company_id WHERE w.user_id = $1 AND w.saved_search_id = $2)
     SELECT count(*)::int AS leads,
            count(*) FILTER (WHERE website_url IS NOT NULL)::int AS website,
            count(*) FILTER (WHERE last_enriched_at IS NOT NULL AND cstatus = 'active')::int AS site_ok,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp LEFT JOIN people p ON p.id = cp.person_id
                                            WHERE cp.type = 'email' AND (cp.company_id = l.company_id OR p.current_company_id = l.company_id)))::int AS email,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp LEFT JOIN people p ON p.id = cp.person_id
                                            WHERE cp.type = 'email' AND cp.mx_valid AND (cp.company_id = l.company_id OR p.current_company_id = l.company_id)))::int AS email_mx,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points cp LEFT JOIN people p ON p.id = cp.person_id
                                            WHERE cp.type = 'email' AND cp.label = 'direct' AND (cp.company_id = l.company_id OR p.current_company_id = l.company_id)))::int AS email_direct,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points WHERE company_id = l.company_id AND type = 'phone'))::int AS phone,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contact_points WHERE company_id = l.company_id AND type = 'whatsapp'))::int AS whatsapp,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM social_profiles WHERE company_id = l.company_id AND platform = 'linkedin'))::int AS linkedin,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM social_profiles WHERE company_id = l.company_id AND platform IN ('facebook', 'instagram')))::int AS fb_ig,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM people WHERE current_company_id = l.company_id AND deleted_at IS NULL))::int AS person,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM people WHERE current_company_id = l.company_id AND seniority IN ('owner', 'c_level', 'director')))::int AS decision_maker,
            count(*) FILTER (WHERE jsonb_array_length(tech_stack) > 0)::int AS tech,
            count(*) FILTER (WHERE (hiring_signals->>'careers_page')::boolean)::int AS careers,
            count(*) FILTER (WHERE description IS NOT NULL)::int AS description,
            round(avg(fit_score))::int AS avg_score,
            count(*) FILTER (WHERE score_tier = 'hot')::int AS hot,
            count(*) FILTER (WHERE score_tier = 'warm')::int AS warm,
            count(*) FILTER (WHERE score_tier = 'cold')::int AS cold
       FROM l`,
    [userId, searchId]
  );
  const misses = await dbPool.query<{ domain: string }>(
    `SELECT c.primary_domain AS domain FROM workspace_leads w JOIN companies c ON c.id = w.company_id
      WHERE w.user_id = $1 AND w.saved_search_id = $2 AND c.status = 'active' AND c.last_enriched_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM contact_points WHERE company_id = c.id AND type = 'email') LIMIT 8`,
    [userId, searchId]
  );
  return { ...r.rows[0], misses: misses.rows.map((m) => m.domain) };
}

async function run() {
  if (niches.length === 0) {
    console.error('Give niches like "dentist|Lahore|PK".');
    process.exit(1);
  }
  const userId = await setupUser();
  // Free search engines block bots at once (see report); company websites + OSM only.
  await dbPool.query(`UPDATE sources SET is_enabled = code IN ('osm', 'website'), cooldown_until = NULL`);
  const results: Array<{ niche: (typeof niches)[number]; runId: number; seconds: number; run: Record<string, unknown>; cov: Record<string, unknown> }> = [];
  for (const n of niches) {
    const label = getCategory(n.category)?.label ?? n.category;
    console.log(`\n${label} in ${n.city}: target ${TARGET}`);
    const s = await dbPool.query<{ id: number }>(
      `INSERT INTO saved_searches (user_id, name, category, keywords, city, country_code, target_per_run) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
      [userId, `${label} in ${n.city} (coverage)`, getCategory(n.category) ? n.category : null, JSON.stringify(getCategory(n.category) ? [] : [n.category]), n.city, n.country, TARGET]
    );
    const searchId = s.rows[0]!.id;
    const runId = (await dbPool.query<{ id: number }>(
      `INSERT INTO scrape_runs (user_id, saved_search_id, run_date, run_type, status) VALUES ($1, $2, current_date, 'manual', 'queued') RETURNING id`,
      [userId, searchId]
    )).rows[0]!.id;
    const t0 = Date.now();
    await startRun(runId);
    await drain();
    const seconds = Math.round((Date.now() - t0) / 1000);
    const run = (await dbPool.query(`SELECT status, stats, error FROM scrape_runs WHERE id = $1`, [runId])).rows[0];
    const cov = await coverage(userId, searchId);
    console.log(`  run ${run.status} in ${seconds}s:`, run.stats, cov);
    results.push({ niche: n, runId, seconds, run, cov });
  }
  const tasks = (await dbPool.query(
    `SELECT task_type, status, count(*)::int AS n FROM scrape_tasks WHERE run_id = ANY($1) GROUP BY 1, 2 ORDER BY 1, 2`,
    [results.map((r) => r.runId)]
  )).rows;
  const errors = (await dbPool.query(
    `SELECT left(last_error, 90) AS e, count(*)::int AS n FROM scrape_tasks WHERE run_id = ANY($1) AND last_error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    [results.map((r) => r.runId)]
  )).rows;

  const head = `| Field | ${results.map((r) => `${getCategory(r.niche.category)?.label ?? r.niche.category}, ${r.niche.city}`).join(' | ')} |\n|---|${results.map(() => '---:').join('|')}|`;
  const line = (label: string, fn: (r: (typeof results)[number]) => string) => `| ${label} | ${results.map(fn).join(' | ')} |`;
  const c = (k: string) => (r: (typeof results)[number]) => pct(Number(r.cov[k]), Number(r.cov.leads));
  const md = [
    `# Lead Engine: field coverage on real data`,
    '',
    `Measured ${new Date().toISOString().slice(0, 10)} with \`scripts/leadgenCoverage.ts\` (target ${TARGET} leads per niche, ${CONCURRENCY} tasks at once).`,
    'Sources: OpenStreetMap (Nominatim + Overpass) and the companies\' own websites (robots.txt respected, 1 request / 2 s per host, max 8 pages).',
    'Search engines were **off**: DuckDuckGo answers our identifying bot User-Agent with a CAPTCHA page on the first request, and no SERP API key was set.',
    'So the search-based discovery and LinkedIn-from-search-results columns are not measured here.',
    '',
    head,
    line('Businesses found by OSM', (r) => String((r.run.stats as Record<string, number>).discovered ?? 0)),
    line('New leads', (r) => String(r.cov.leads)),
    line('Run status / time', (r) => `${r.run.status} / ${r.seconds}s`),
    line('Website known', c('website')),
    line('Website reachable and crawled', c('site_ok')),
    line('Any email', c('email')),
    line('Email domain with MX', c('email_mx')),
    line('Direct (not info@) email', c('email_direct')),
    line('Phone', c('phone')),
    line('WhatsApp', c('whatsapp')),
    line('LinkedIn company page (from website)', c('linkedin')),
    line('Facebook / Instagram', c('fb_ig')),
    line('A person (team page / JSON-LD)', c('person')),
    line('Decision maker (owner / C-level / director)', c('decision_maker')),
    line('Tech signals', c('tech')),
    line('Careers page', c('careers')),
    line('Description', c('description')),
    line('Average fit score', (r) => String(r.cov.avg_score ?? 0)),
    line('Hot / warm / cold', (r) => `${r.cov.hot} / ${r.cov.warm} / ${r.cov.cold}`),
    '',
    'Percentages are of the new leads of that niche.',
    '',
    '## Tasks',
    '',
    '| Task | Status | Count |',
    '|---|---|---:|',
    ...tasks.map((t) => `| ${t.task_type} | ${t.status} | ${t.n} |`),
    '',
    '## Most common task errors',
    '',
    ...(errors.length ? errors.map((e) => `- ${e.n}× ${e.e}`) : ['- none']),
    '',
    '## Sites that were crawled but gave no email (sample, for extractor fixes)',
    '',
    ...results.map((r) => `- ${r.niche.category} / ${r.niche.city}: ${(r.cov.misses as string[]).join(', ') || 'none'}`),
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md);
  console.log(`\nReport written to ${OUT}`);
  await dbPool.end();
}

run().catch(async (err) => {
  console.error('Coverage run failed:', err);
  await dbPool.end().catch(() => undefined);
  process.exit(1);
});
