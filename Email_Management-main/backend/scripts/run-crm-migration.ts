/**
 * Applies the CRM migrations in one transaction:
 *   drizzle/0031_crm_module.sql       (step 1: CRM tables)
 *   drizzle/0032_crm_rules.sql        (step 3: rule engine columns + scheduled follow-ups)
 *   drizzle/0033_crm_tags.sql         (step 5: campaign CRM settings + tag indexes)
 *   drizzle/0034_crm_needs_reply.sql  (step 6: needs-reply columns + indexes)
 *   drizzle/0035_crm_scoring.sql      (step 7: score breakdown columns)
 *   drizzle/0036_crm_indexes.sql      (step 9: indexes for big accounts)
 * then fills crm_contacts.needs_reply from the replies you already have (step 6, no reminders for old data)
 * and calculates every lead score (step 7).
 *
 *   npx tsx scripts/run-crm-migration.ts                 # apply all (safe to run again)
 *   npx tsx scripts/run-crm-migration.ts --rollback-step9 # undo only 0036 (step 9 indexes)
 *   npx tsx scripts/run-crm-migration.ts --rollback-step7 # undo 0036 and 0035 (steps 9 and 7)
 *   npx tsx scripts/run-crm-migration.ts --rollback-step6 # undo 0036 … 0034 (steps 9, 7 and 6)
 *   npx tsx scripts/run-crm-migration.ts --rollback-step5 # undo 0036 … 0033 (steps 9, 7, 6 and 5)
 *   npx tsx scripts/run-crm-migration.ts --rollback-step3 # undo 0036 … 0032 (steps 9, 7, 6, 5 and 3)
 *   npx tsx scripts/run-crm-migration.ts --rollback       # undo everything CRM (0036 … 0031)
 *
 * Uses DATABASE_URL from backend/.env. Take a database backup before running.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dbPool } from '../src/lib/db.js';
import { recomputeNeedsReply } from '../src/lib/crm/needsReply.js';
import { recalcScores } from '../src/lib/crm/leadScoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Oldest first. `step` is the step the migration belongs to. */
const MIGRATIONS = [
  { step: 1, file: '0031_crm_module' },
  { step: 3, file: '0032_crm_rules' },
  { step: 5, file: '0033_crm_tags' },
  { step: 6, file: '0034_crm_needs_reply' },
  { step: 7, file: '0035_crm_scoring' },
  { step: 9, file: '0036_crm_indexes' },
];

const flag = process.argv.find((a) => a.startsWith('--rollback'));
const rollbackFrom = flag === '--rollback' ? 1 : flag ? Number(flag.replace('--rollback-step', '')) : null;
if (flag && (rollbackFrom == null || !MIGRATIONS.some((m) => m.step === rollbackFrom))) {
  console.error(`Unknown option ${flag}. Use --rollback, --rollback-step3, --rollback-step5, --rollback-step6, --rollback-step7 or --rollback-step9.`);
  process.exit(1);
}

const files =
  rollbackFrom != null
    ? MIGRATIONS.filter((m) => m.step >= rollbackFrom).reverse().map((m) => `${m.file}_rollback.sql`)
    : MIGRATIONS.map((m) => `${m.file}.sql`);

async function run() {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    for (const file of files) {
      const sqlText = fs.readFileSync(path.join(__dirname, '..', 'drizzle', file), 'utf8');
      console.log(`${rollbackFrom != null ? 'Rolling back' : 'Applying'}: ${file}`);
      await client.query(sqlText);
    }
    if (rollbackFrom == null) {
      // Step 6: mark leads that already wait for your reply. They show in Inbox → Needs reply,
      // but no bell reminders are created for this old data.
      const changed = await recomputeNeedsReply(client, null, { markNotified: true });
      console.log(`Needs-reply check: ${changed} lead(s) updated.`);
    }
    await client.query('COMMIT');
    if (rollbackFrom == null) {
      // Step 7: calculate every lead score (in batches, outside the migration transaction).
      // If this fails, the migrations above are still applied: the CRM worker calculates the scores later.
      try {
        const ids = (await dbPool.query<{ id: number }>(`SELECT id FROM crm_contacts ORDER BY id`)).rows.map((r) => r.id);
        for (let i = 0; i < ids.length; i += 200) await recalcScores(dbPool, ids.slice(i, i + 200));
        console.log(`Lead scores calculated: ${ids.length} lead(s).`);
      } catch (err) {
        console.error('Migrations applied, but calculating the lead scores failed (the CRM worker will do it later):', err);
      }
    }
    console.log(
      rollbackFrom === 1
        ? 'All CRM tables and columns removed.'
        : rollbackFrom != null
          ? `CRM changes of step ${rollbackFrom} and later removed.`
          : 'CRM migrations applied.'
    );
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
