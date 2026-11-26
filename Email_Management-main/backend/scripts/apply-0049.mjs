// Applies migration 0049 (additive only — adds smtp_setting_ids to crm_automations, no drops).
// Run from the backend folder: node scripts/apply-0049.mjs
import pg from 'pg';
import fs from 'fs';

const url = fs.readFileSync('.env', 'utf8').match(/^DATABASE_URL=(.*)$/m)[1].trim();
const client = new pg.Client({ connectionString: url });
await client.connect();

const file = '0049_automation_smtp_accounts.sql';
try {
  await client.query(fs.readFileSync(`drizzle/${file}`, 'utf8'));
  const { rows } = await client.query(
    "select column_name from information_schema.columns where table_name='crm_automations' and column_name='smtp_setting_ids'",
  );
  // Recorded like scripts/apply-sql-migrations.ts does, when that table exists.
  const tracked = await client.query("select to_regclass('public._sql_migrations') as t");
  if (tracked.rows[0]?.t) {
    await client.query('INSERT INTO _sql_migrations (filename) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM _sql_migrations WHERE filename = $1)', [file]);
  }
  console.log(rows.length ? `OK: drizzle/${file}` : `FAILED: drizzle/${file}`);
} catch (e) {
  console.error(`ERROR in drizzle/${file}:`, e.message);
  await client.end();
  process.exit(1);
}

await client.end();
