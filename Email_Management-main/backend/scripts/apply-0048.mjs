// Applies migration 0048 (additive only — adds 3 columns to crm_automations, no drops).
// Run from the backend folder: node scripts/apply-0048.mjs
import pg from 'pg';
import fs from 'fs';

const url = fs.readFileSync('.env', 'utf8').match(/^DATABASE_URL=(.*)$/m)[1].trim();
const client = new pg.Client({ connectionString: url });
await client.connect();

const file = 'drizzle/0048_automation_send_window.sql';
try {
  await client.query(fs.readFileSync(file, 'utf8'));
  const { rows } = await client.query(
    "select column_name from information_schema.columns where table_name='crm_automations' and column_name in ('send_weekdays','daily_send_window_start','daily_send_window_end')",
  );
  console.log(rows.length === 3 ? `OK: ${file}` : `FAILED: ${file} (columns found: ${rows.map((r) => r.column_name).join(', ') || 'none'})`);
} catch (e) {
  console.error(`ERROR in ${file}:`, e.message);
  await client.end();
  process.exit(1);
}

await client.end();
