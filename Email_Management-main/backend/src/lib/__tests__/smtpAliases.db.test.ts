/**
 * Run: ALIAS_TEST_DATABASE_URL=postgres://.../email_test npm run test:aliases
 *
 * Needs a THROWAWAY database with the app schema through migration 0045_smtp_aliases.sql.
 * Skipped when ALIAS_TEST_DATABASE_URL is not set. Never point it at a real database — it inserts
 * and deletes its own rows but shares the connection.
 *
 * Per-alias sending (migration 0042): every SMTP profile owns a list of aliases, each alias has its
 * own daily quota (default 20), so a profile with N aliases can send up to N×20 per day.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DB = process.env.ALIAS_TEST_DATABASE_URL;
const skip = !TEST_DB ? 'set ALIAS_TEST_DATABASE_URL to a throwaway database' : false;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

type Mods = {
  db: typeof import('../db.js');
  smtp: typeof import('../smtpSettings.js');
  quota: typeof import('../dailySendQuota.js');
};
let m: Mods;
let userId = 0;
let smtpId = 0;
let campaignId = 0;
let primaryAliasId = 0;
let secondAliasId = 0;

const q = (sql: string, params: unknown[] = []) => m.db.dbPool.query(sql, params);

before(async () => {
  if (skip) return;
  m = {
    db: await import('../db.js'),
    smtp: await import('../smtpSettings.js'),
    quota: await import('../dailySendQuota.js'),
  };
  const u = await q(
    `INSERT INTO users (name, email, password_hash) VALUES ('AliasTest', $1, 'x') RETURNING id`,
    [`alias_db_test_${Date.now()}@example.com`]
  );
  userId = u.rows[0].id;
  smtpId = await m.smtp.insertSmtpProfile(
    userId,
    {
      provider: 'custom', host: 'smtp.company.com', port: 587, secure: false,
      user: 'contact@company.com', password: 'secret', fromName: 'Primary', fromEmail: 'contact@company.com',
    },
    999
  );
  const camp = await q(
    `INSERT INTO campaigns (user_id, smtp_settings_id, name, subject, email_content, from_name, from_email)
     VALUES ($1, $2, 'c', 's', 'b', 'n', 'contact@company.com') RETURNING id`,
    [userId, smtpId]
  );
  campaignId = camp.rows[0].id;
});

after(async () => {
  if (skip || !m) return;
  if (userId) {
    await q(`DELETE FROM email_send_log WHERE user_id = $1`, [userId]);
    await q(`DELETE FROM campaigns WHERE user_id = $1`, [userId]);
    await q(`DELETE FROM smtp_aliases WHERE user_id = $1`, [userId]);
    await q(`DELETE FROM smtp_settings WHERE user_id = $1`, [userId]);
    await q(`DELETE FROM users WHERE id = $1`, [userId]);
  }
  await m.db.dbPool.end();
});

test('a new profile auto-creates its primary alias', { skip }, async () => {
  const aliases = await m.smtp.listAliasesForProfile(userId, smtpId);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0]!.fromEmail, 'contact@company.com');
  primaryAliasId = aliases[0]!.id;
});

test('a second alias can be added; capacity is the sum of alias caps', { skip }, async () => {
  secondAliasId = await m.smtp.insertAlias(userId, smtpId, { fromEmail: 'sales@company.com', fromName: 'Sales' });
  const capacity = await m.quota.capacityForProfile(userId, smtpId);
  assert.equal(capacity, 40, 'two aliases at 20 each = 40/day');
});

test('a duplicate alias email (case-insensitive) is rejected', { skip }, async () => {
  await assert.rejects(
    () => m.smtp.insertAlias(userId, smtpId, { fromEmail: 'SALES@company.com' }),
    /ALIAS_DUPLICATE_EMAIL/
  );
});

test('each alias is counted against its own quota independently', { skip }, async () => {
  for (let i = 0; i < 20; i++) {
    await m.quota.recordSuccessfulSend(userId, smtpId, campaignId, primaryAliasId);
  }
  const primarySent = await m.quota.countSendsTodayForAlias(userId, primaryAliasId, { smtpSettingsId: smtpId, isPrimary: true });
  const secondSent = await m.quota.countSendsTodayForAlias(userId, secondAliasId, { smtpSettingsId: smtpId, isPrimary: false });
  assert.equal(primarySent, 20, 'primary alias used its full quota');
  assert.equal(secondSent, 0, 'the second alias is untouched and still has its own 20');
});

test('a lower per-alias cap reduces only that alias and the profile capacity', { skip }, async () => {
  await m.smtp.updateAlias(userId, secondAliasId, { dailyEmailLimit: 5 });
  const capacity = await m.quota.capacityForProfile(userId, smtpId);
  assert.equal(capacity, 25, 'primary 20 + second 5');
});

test('the primary alias cannot be deleted; a non-primary one can', { skip }, async () => {
  await assert.rejects(() => m.smtp.deleteAlias(userId, primaryAliasId), /ALIAS_PRIMARY_LOCKED/);
  await m.smtp.deleteAlias(userId, secondAliasId);
  const aliases = await m.smtp.listAliasesForProfile(userId, smtpId);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0]!.id, primaryAliasId);
});
