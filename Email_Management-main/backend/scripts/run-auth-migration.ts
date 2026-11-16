/**
 * Applies drizzle/0038_auth_refresh_tokens.sql (N-07 / N-17 cookie sessions) in one transaction.
 *
 *   npx tsx scripts/run-auth-migration.ts             # apply (safe to run again)
 *   npx tsx scripts/run-auth-migration.ts --rollback  # undo (drops auth_refresh_tokens; everyone signs in again)
 *
 * Uses DATABASE_URL from backend/.env. Take a database backup before running.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dbPool } from '../src/lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rollback = process.argv.includes('--rollback');
const file = rollback ? '0038_auth_refresh_tokens_rollback.sql' : '0038_auth_refresh_tokens.sql';

async function run() {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    console.log(`${rollback ? 'Rolling back' : 'Applying'}: ${file}`);
    await client.query(fs.readFileSync(path.join(__dirname, '..', 'drizzle', file), 'utf8'));
    await client.query('COMMIT');
    console.log(rollback ? 'auth_refresh_tokens removed.' : 'auth_refresh_tokens ready.');
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
