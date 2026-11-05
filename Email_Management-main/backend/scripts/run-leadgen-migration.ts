/**
 * Applies the Lead Engine migration in one transaction:
 *   drizzle/0037_lead_engine.sql  (19 tables, plan flags, source seeds)
 * Run after the CRM migrations (workspace_leads references crm_contacts).
 *
 *   npx tsx scripts/run-leadgen-migration.ts             # apply (safe to run again)
 *   npx tsx scripts/run-leadgen-migration.ts --rollback  # drop all lead engine tables and plan columns
 *
 * Uses DATABASE_URL from backend/.env. Take a database backup before running.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dbPool } from '../src/lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const unknown = process.argv.slice(2).filter((a) => a !== '--rollback');
if (unknown.length > 0) {
  console.error(`Unknown option ${unknown[0]}. Use --rollback or no option.`);
  process.exit(1);
}
const rollback = process.argv.includes('--rollback');
const file = rollback ? '0037_lead_engine_rollback.sql' : '0037_lead_engine.sql';

async function run() {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const crm = await client.query<{ t: string | null }>(`SELECT to_regclass('crm_contacts')::text AS t`);
    if (!rollback && !crm.rows[0]?.t) {
      throw new Error('crm_contacts is missing. Run scripts/run-crm-migration.ts first.');
    }
    const sqlText = fs.readFileSync(path.join(__dirname, '..', 'drizzle', file), 'utf8');
    console.log(`${rollback ? 'Rolling back' : 'Applying'}: ${file}`);
    await client.query(sqlText);
    await client.query('COMMIT');
    if (rollback) {
      console.log('All lead engine tables and plan columns removed.');
    } else {
      const n = await dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM sources`);
      console.log(`Lead engine migration applied (${n.rows[0]?.n ?? 0} sources).`);
    }
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
