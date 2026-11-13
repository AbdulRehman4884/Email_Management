/**
 * Applies the automation migrations in one transaction:
 *   drizzle/0040_crm_automations.sql       (form automations)
 *   drizzle/0041_campaign_automations.sql  (campaign automations)
 *
 *   npx tsx scripts/run-automation-migration.ts                  # apply both (safe to run again)
 *   npx tsx scripts/run-automation-migration.ts --rollback-0041  # undo only 0041 (campaign automations)
 *   npx tsx scripts/run-automation-migration.ts --rollback       # undo both (drops every automation table and column)
 *
 * Needs the CRM tables (scripts/run-crm-migration.ts) first. Uses DATABASE_URL from backend/.env.
 * Take a database backup before running.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dbPool } from '../src/lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ['0040_crm_automations', '0041_campaign_automations'];

const flag = process.argv[2];
if (flag && flag !== '--rollback' && flag !== '--rollback-0041') {
  console.error(`Unknown option ${flag}. Use --rollback, --rollback-0041 or no option.`);
  process.exit(1);
}
const files =
  flag === '--rollback' ? [...MIGRATIONS].reverse().map((m) => `${m}_rollback.sql`)
    : flag === '--rollback-0041' ? ['0041_campaign_automations_rollback.sql']
      : MIGRATIONS.map((m) => `${m}.sql`);

async function run() {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    for (const file of files) {
      console.log(`${flag ? 'Rolling back' : 'Applying'}: ${file}`);
      await client.query(fs.readFileSync(path.join(__dirname, '..', 'drizzle', file), 'utf8'));
    }
    await client.query('COMMIT');
    console.log(flag ? 'Rolled back.' : 'Automation tables ready.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed, nothing was changed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await dbPool.end();
  }
}

void run();
