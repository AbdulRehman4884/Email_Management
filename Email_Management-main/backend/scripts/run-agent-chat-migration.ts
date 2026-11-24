/**
 * Applies the AI Agent chat migrations in one transaction: 0042 (chat history) and 0044 (pin, rename, Library).
 *
 *   npx tsx scripts/run-agent-chat-migration.ts             # apply both (safe to run again)
 *   npx tsx scripts/run-agent-chat-migration.ts --rollback  # undo both (deletes every saved chat and Library file)
 *
 * Uses DATABASE_URL from backend/.env. Until it runs, /api/agent-chats answers 503 and the
 * AI Agent page keeps its chat in the browser only (as before).
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
const files = flag === '--rollback'
  ? ['0044_agent_chat_pins_library_rollback.sql', '0042_agent_chats_rollback.sql']
  : ['0042_agent_chats.sql', '0044_agent_chat_pins_library.sql'];

async function run() {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    for (const file of files) {
      console.log(`${flag ? 'Rolling back' : 'Applying'}: ${file}`);
      await client.query(fs.readFileSync(path.join(__dirname, '..', 'drizzle', file), 'utf8'));
    }
    await client.query('COMMIT');
    console.log(flag ? 'Rolled back.' : 'Agent chat history, pins and Library ready.');
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
