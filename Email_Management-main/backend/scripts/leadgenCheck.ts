/**
 * Checks that the database matches the Lead Engine block of src/db/schema.ts
 * (tables, columns, nullability, indexes) and that the sources are seeded.
 *
 *   npm run leadgen:check
 *
 * Read-only. Uses DATABASE_URL from backend/.env.
 */
import 'dotenv/config';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/db/schema.js';
import { dbPool } from '../src/lib/db.js';

const LEAD_TABLES = [
  'sources', 'companies', 'company_domains', 'people', 'employments', 'contact_points', 'social_profiles',
  'web_pages', 'entity_merges', 'saved_searches', 'search_schedules', 'scrape_runs', 'observations',
  'scrape_tasks', 'source_daily_usage', 'leadgen_cache', 'workspace_leads', 'data_subject_requests', 'do_not_collect',
];
const PLAN_COLUMNS = ['lead_gen_enabled', 'lead_gen_daily_limit'];

async function run() {
  const problems: string[] = [];
  const tables = Object.values(schema)
    .map((t) => { try { return getTableConfig(t as PgTable); } catch { return null; } })
    .filter((c): c is ReturnType<typeof getTableConfig> => c !== null && LEAD_TABLES.includes(c.name));

  for (const cfg of tables) {
    const cols = await dbPool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [cfg.name]
    );
    if (cols.rows.length === 0) {
      problems.push(`missing table ${cfg.name}`);
      continue;
    }
    const inDb = new Map(cols.rows.map((r) => [r.column_name, r.is_nullable === 'YES']));
    for (const c of cfg.columns) {
      if (!inDb.has(c.name)) problems.push(`${cfg.name}.${c.name}: missing in database`);
      else if (inDb.get(c.name) !== !c.notNull) problems.push(`${cfg.name}.${c.name}: nullability differs`);
      inDb.delete(c.name);
    }
    for (const extra of inDb.keys()) problems.push(`${cfg.name}.${extra}: in database but not in schema.ts`);

    const idx = await dbPool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = $1`, [cfg.name]);
    const names = new Set(idx.rows.map((r) => r.indexname));
    for (const i of cfg.indexes) if (i.config.name && !names.has(i.config.name)) problems.push(`${cfg.name}: index ${i.config.name} missing`);
  }
  for (const t of LEAD_TABLES) if (!tables.some((c) => c.name === t)) problems.push(`${t}: not in schema.ts`);

  const plan = await dbPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'plans' AND column_name = ANY($1)`,
    [PLAN_COLUMNS]
  );
  for (const c of PLAN_COLUMNS) if (!plan.rows.some((r) => r.column_name === c)) problems.push(`plans.${c}: missing`);

  if (!problems.some((p) => p.startsWith('missing table sources'))) {
    const src = await dbPool.query<{ code: string }>(`SELECT code FROM sources`);
    for (const code of ['osm', 'ddg', 'serp_api', 'website', 'search_linkedin']) {
      if (!src.rows.some((r) => r.code === code)) problems.push(`source ${code} not seeded`);
    }
  }

  if (problems.length === 0) {
    console.log(`Lead engine OK: ${tables.length} tables match schema.ts, plan flags and sources present.`);
  } else {
    for (const p of problems) console.log(`  - ${p}`);
    console.log(`\n${problems.length} problem(s). Run: npx tsx scripts/run-leadgen-migration.ts`);
    process.exitCode = 1;
  }
  await dbPool.end();
}

void run();
