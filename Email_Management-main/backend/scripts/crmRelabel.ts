/**
 * Labels every inbound reply that has no CRM label yet, for all users (same as POST /api/crm/relabel,
 * without needing a login or plan). Fires no CRM events, so leads do not move between stages.
 *
 *   npx tsx scripts/crmRelabel.ts      (or: npm run crm:relabel)
 *
 * Safe to run again: replies that already have a label (and labels you changed by hand) are skipped.
 */
import 'dotenv/config';
import { dbPool } from '../src/lib/db.js';
import { relabelUnlabeledReplies } from '../src/lib/crm/labelReply.js';

async function main() {
  const users = await dbPool.query<{ user_id: number; c: number }>(
    `SELECT c.user_id, count(*)::int AS c
       FROM email_replies er JOIN campaigns c ON c.id = er.campaign_id
      WHERE er.direction = 'inbound' AND er.label IS NULL
      GROUP BY c.user_id ORDER BY c.user_id`
  );
  if (users.rows.length === 0) {
    console.log('Nothing to do: every inbound reply already has a label.');
    return;
  }
  for (const u of users.rows) {
    let remaining = u.c;
    console.log(`user #${u.user_id}: ${u.c} reply(ies) without a label`);
    while (remaining > 0) {
      const r = await relabelUnlabeledReplies(u.user_id, { batchSize: 200, maxReplies: 2000 });
      console.log(`  labeled ${r.processed}, failed ${r.failed}, left ${r.remaining}`, r.byLabel);
      if (r.processed === 0) break; // only failures left; avoid looping forever
      remaining = r.remaining;
    }
  }
  console.log('Relabel finished.');
}

main()
  .catch((err) => {
    console.error('Relabel failed:', err);
    process.exitCode = 1;
  })
  .finally(() => dbPool.end());
