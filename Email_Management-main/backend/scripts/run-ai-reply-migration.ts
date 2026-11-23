/**
 * Applies the AI reply agent migration (drizzle/0043_ai_reply_agent.sql) in one transaction.
 *
 *   npx tsx scripts/run-ai-reply-migration.ts             # apply (safe to run again)
 *   npx tsx scripts/run-ai-reply-migration.ts --rollback  # undo (deletes every AI draft and AI reply setting)
 *
 * Uses DATABASE_URL from backend/.env. Until it runs the AI reply agent stays off and its API answers 503;
 * everything else works as before. (AI first lines need no migration.)
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dbPool } from '../src/lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const flag = process.argv[2];
if (flag && flag !== '--rollback') {
  console.error(`Unknown option ${flag}. Use --rollback or no option.`);
  process.exit(1);
}
const file = flag === '--rollback' ? '0043_ai_reply_agent_rollback.sql' : '0043_ai_reply_agent.sql';

async function run() {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    console.log(`${flag ? 'Rolling back' : 'Applying'}: ${file}`);
    await client.query(fs.readFileSync(path.join(__dirname, '..', 'drizzle', file), 'utf8'));
    await client.query('COMMIT');
    console.log(flag ? 'Rolled back.' : 'AI reply agent tables ready.');
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
