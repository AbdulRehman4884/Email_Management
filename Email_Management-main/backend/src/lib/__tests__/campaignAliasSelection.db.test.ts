/**
 * Run: ALIAS_TEST_DATABASE_URL=postgres://.../email_test npm run test:campaign-aliases
 *
 * Needs a THROWAWAY database with the app schema through migration 0046_campaign_alias_selection.sql.
 * Skipped when ALIAS_TEST_DATABASE_URL is not set. Never point it at a real database — it inserts
 * and deletes its own rows but shares the connection.
 *
 * Campaign per-alias selection (migration 0043): a campaign may restrict which sending aliases it
 * uses via campaigns.alias_ids. Empty [] = every active alias of the selected profile(s). This test
 * covers capacityForAliases() and the worker's real pickAvailableAlias() allow-list + quota filter.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DB = process.env.ALIAS_TEST_DATABASE_URL;
const skip = !TEST_DB ? 'set ALIAS_TEST_DATABASE_URL to a throwaway database' : false;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
// Stop the worker's poll loop from starting when we import the module for pickAvailableAlias().
process.env.EMAIL_WORKER_NO_RUN = '1';

type Mods = {
  db: typeof import('../db.js');
  smtp: typeof import('../smtpSettings.js');
  quota: typeof import('../dailySendQuota.js');
  worker: typeof import('../../workers/emailWorker.js');
};
let m: Mods;
let userId = 0;
let otherUserId = 0;
let smtpId = 0;
let campaignId = 0;
let primaryAliasId = 0; // contact@company.com (cap 20)
let salesAliasId = 0; // sales@company.com
let supportAliasId = 0; // support@company.com

const q = (sql: string, params: unknown[] = []) => m.db.dbPool.query(sql, params);

before(async () => {
  if (skip) return;
  m = {
    db: await import('../db.js'),
    smtp: await import('../smtpSettings.js'),
    quota: await import('../dailySendQuota.js'),
    worker: await import('../../workers/emailWorker.js'),
  };
  const u = await q(
    `INSERT INTO users (name, email, password_hash) VALUES ('CampAliasTest', $1, 'x') RETURNING id`,
    [`camp_alias_test_${Date.now()}@example.com`]
  );
  userId = u.rows[0].id;
  const u2 = await q(
    `INSERT INTO users (name, email, password_hash) VALUES ('OtherUser', $1, 'x') RETURNING id`,
    [`camp_alias_other_${Date.now()}@example.com`]
  );
  otherUserId = u2.rows[0].id;

  smtpId = await m.smtp.insertSmtpProfile(
    userId,
    {
      provider: 'custom', host: 'smtp.company.com', port: 587, secure: false,
      user: 'contact@company.com', password: 'secret', fromName: 'Primary', fromEmail: 'contact@company.com',
    },
    999
  );
  const aliases = await m.smtp.listAliasesForProfile(userId, smtpId);
  primaryAliasId = aliases[0]!.id; // auto-created primary
  salesAliasId = await m.smtp.insertAlias(userId, smtpId, { fromEmail: 'sales@company.com', fromName: 'Sales' });
  supportAliasId = await m.smtp.insertAlias(userId, smtpId, { fromEmail: 'support@company.com', fromName: 'Support' });

  const camp = await q(
    `INSERT INTO campaigns (user_id, smtp_settings_id, name, subject, email_content, from_name, from_email)
     VALUES ($1, $2, 'c', 's', 'b', 'n', 'contact@company.com') RETURNING id`,
    [userId, smtpId]
  );
  campaignId = camp.rows[0].id;
});

after(async () => {
  if (skip || !m) return;
  for (const uid of [userId, otherUserId]) {
    if (!uid) continue;
    await q(`DELETE FROM email_send_log WHERE user_id = $1`, [uid]);
    await q(`DELETE FROM campaigns WHERE user_id = $1`, [uid]);
    await q(`DELETE FROM smtp_aliases WHERE user_id = $1`, [uid]);
    await q(`DELETE FROM smtp_settings WHERE user_id = $1`, [uid]);
    await q(`DELETE FROM users WHERE id = $1`, [uid]);
  }
  await m.db.dbPool.end();
});

// ── capacityForAliases ──────────────────────────────────────────────────────

test('capacityForAliases([]) is 0 (no aliases chosen)', { skip }, async () => {
  assert.equal(await m.quota.capacityForAliases(userId, []), 0);
});

test('capacityForAliases sums each chosen alias cap (3 × 20 = 60)', { skip }, async () => {
  const cap = await m.quota.capacityForAliases(userId, [primaryAliasId, salesAliasId, supportAliasId]);
  assert.equal(cap, 60);
});

test('a subset capacity is less than the full-profile capacity', { skip }, async () => {
  const subset = await m.quota.capacityForAliases(userId, [salesAliasId]);
  const full = await m.quota.capacityForProfile(userId, smtpId);
  assert.equal(subset, 20);
  assert.ok(subset < full, `subset ${subset} should be < full ${full}`);
});

test('a lowered per-alias cap is reflected in the alias-subset capacity', { skip }, async () => {
  await m.smtp.updateAlias(userId, salesAliasId, { dailyEmailLimit: 5 });
  const cap = await m.quota.capacityForAliases(userId, [primaryAliasId, salesAliasId]);
  assert.equal(cap, 25, 'primary 20 + sales 5');
  await m.smtp.updateAlias(userId, salesAliasId, { dailyEmailLimit: null }); // restore
});

test('a blocked alias (limit 0) contributes 0 capacity', { skip }, async () => {
  await m.smtp.updateAlias(userId, supportAliasId, { dailyEmailLimit: 0 });
  assert.equal(await m.quota.capacityForAliases(userId, [supportAliasId]), 0);
  assert.equal(await m.quota.capacityForAliases(userId, [primaryAliasId, supportAliasId]), 20);
  await m.smtp.updateAlias(userId, supportAliasId, { dailyEmailLimit: null }); // restore
});

test('capacityForAliases ignores aliases belonging to another user', { skip }, async () => {
  assert.equal(await m.quota.capacityForAliases(otherUserId, [primaryAliasId, salesAliasId]), 0);
});

// ── worker pickAvailableAlias allow-list + quota filter ──────────────────────

test('allow-list [sales] picks sales, not the primary (even though primary is first)', { skip }, async () => {
  await q(`DELETE FROM email_send_log WHERE user_id = $1`, [userId]);
  const picked = await m.worker.pickAvailableAlias(userId, [smtpId], [salesAliasId]);
  assert.ok(picked, 'an alias should be available');
  assert.equal(picked!.alias.id, salesAliasId);
  assert.equal(picked!.alias.fromEmail, 'sales@company.com');
});

test('empty allow-list falls back to every alias → primary (first) is chosen', { skip }, async () => {
  await q(`DELETE FROM email_send_log WHERE user_id = $1`, [userId]);
  const picked = await m.worker.pickAvailableAlias(userId, [smtpId], []);
  assert.ok(picked);
  assert.equal(picked!.alias.id, primaryAliasId, 'empty = all aliases, primary comes first');
});

test('null allow-list behaves like empty (all aliases)', { skip }, async () => {
  const picked = await m.worker.pickAvailableAlias(userId, [smtpId], null);
  assert.ok(picked);
  assert.equal(picked!.alias.id, primaryAliasId);
});

test('an exhausted allowed alias yields null when no other alias is allowed', { skip }, async () => {
  await q(`DELETE FROM email_send_log WHERE user_id = $1`, [userId]);
  await m.smtp.updateAlias(userId, salesAliasId, { dailyEmailLimit: 2 });
  await m.quota.recordSuccessfulSend(userId, smtpId, campaignId, salesAliasId);
  await m.quota.recordSuccessfulSend(userId, smtpId, campaignId, salesAliasId);
  const picked = await m.worker.pickAvailableAlias(userId, [smtpId], [salesAliasId]);
  assert.equal(picked, null, 'sales is at its 2/day cap and nothing else is allowed');
  await m.smtp.updateAlias(userId, salesAliasId, { dailyEmailLimit: null }); // restore
});

test('with sales exhausted, allow-list [sales, support] rotates to support', { skip }, async () => {
  await q(`DELETE FROM email_send_log WHERE user_id = $1`, [userId]);
  await m.smtp.updateAlias(userId, salesAliasId, { dailyEmailLimit: 1 });
  await m.quota.recordSuccessfulSend(userId, smtpId, campaignId, salesAliasId);
  const picked = await m.worker.pickAvailableAlias(userId, [smtpId], [salesAliasId, supportAliasId]);
  assert.ok(picked);
  assert.equal(picked!.alias.id, supportAliasId, 'sales is exhausted, support is the next allowed one');
  await m.smtp.updateAlias(userId, salesAliasId, { dailyEmailLimit: null }); // restore
});

test('a blocked alias is skipped even when explicitly allowed', { skip }, async () => {
  await q(`DELETE FROM email_send_log WHERE user_id = $1`, [userId]);
  await m.smtp.updateAlias(userId, supportAliasId, { dailyEmailLimit: 0 });
  const picked = await m.worker.pickAvailableAlias(userId, [smtpId], [supportAliasId, primaryAliasId]);
  assert.ok(picked);
  assert.equal(picked!.alias.id, primaryAliasId, 'support is blocked, so primary is chosen');
  await m.smtp.updateAlias(userId, supportAliasId, { dailyEmailLimit: null }); // restore
});
