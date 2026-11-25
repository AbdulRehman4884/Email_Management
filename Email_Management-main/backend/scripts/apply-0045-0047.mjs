// Applies migrations 0045, 0046, and 0047 (additive only — no drops).
// Run from the backend folder: node scripts/apply-0045-0047.mjs
import pg from 'pg';
import fs from 'fs';

const url = fs.readFileSync('.env', 'utf8').match(/^DATABASE_URL=(.*)$/m)[1].trim();
const client = new pg.Client({ connectionString: url });
await client.connect();

for (const [file, check] of [
  ['drizzle/0045_smtp_aliases.sql',         "select to_regclass('public.smtp_aliases') as t"],
  ['drizzle/0046_campaign_alias_selection.sql', "select column_name from information_schema.columns where table_name='campaigns' and column_name='alias_ids'"],
  ['drizzle/0047_followup_send_window.sql',  "select column_name from information_schema.columns where table_name='follow_up_jobs' and column_name='daily_send_window_start'"],
]) {
  try {
    await client.query(fs.readFileSync(file, 'utf8'));
    const { rows } = await client.query(check);
    console.log(rows.length ? `OK: ${file}` : `FAILED: ${file}`);
  } catch (e) {
    if (e.message?.includes('already exists') || e.code === '42P07' || e.code === '42701') {
      console.log(`SKIP (already applied): ${file}`);
    } else {
      console.error(`ERROR in ${file}:`, e.message);
      await client.end();
      process.exit(1);
    }
  }
}

await client.end();
