import 'dotenv/config';
import { getAllImapConfigs, pollImapForUser } from '../lib/imapService.js';

const POLL_INTERVAL_MS = 60_000;

async function pollAll() {
  const configs = await getAllImapConfigs();

  if (configs.length === 0) {
    return;
  }

  console.log(`[IMAP Worker] Polling ${configs.length} mailbox(es)...`);

  for (const config of configs) {
    try {
      const count = await pollImapForUser(config);
      if (count > 0) {
        console.log(`[IMAP Worker] ${config.user}: ${count} new reply(ies) processed`);
      }
    } catch (err) {
      console.error(`[IMAP Worker] Error for ${config.user}:`, err);
    }
  }
}

async function run() {
  console.log('[IMAP Worker] Starting IMAP reply polling worker...');
  console.log(`[IMAP Worker] Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  while (true) {
    try {
      await pollAll();
    } catch (err) {
      console.error('[IMAP Worker] Unexpected error:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

run().catch((err) => {
  console.error('[IMAP Worker] Fatal error:', err);
  process.exit(1);
});
