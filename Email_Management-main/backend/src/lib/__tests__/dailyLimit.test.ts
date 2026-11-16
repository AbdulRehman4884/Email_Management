/**
 * Run: npm run test:limits   (node:test through tsx, no database needed)
 * Bug F-25: "remaining today" on the screens must follow the same 20/day rule as the email worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SMTP_DAILY_EMAIL_LIMIT_MAX } from '../../constants/fieldLimits.js';
import { interpretSmtpDailyLimit, remainingSmtpQuota, smtpQuotaForProfile } from '../dailySendQuota.js';

test('every SMTP account sends at most 20 per day', () => {
  assert.equal(SMTP_DAILY_EMAIL_LIMIT_MAX, 20);
});

test('empty limit = 20, not 50 (the bug: screens showed "50 emails remaining today")', () => {
  assert.deepEqual(smtpQuotaForProfile(null, 0), { dailyLimit: 20, remaining: 20, blocked: false });
  assert.deepEqual(smtpQuotaForProfile(undefined, 0), { dailyLimit: 20, remaining: 20, blocked: false });
});

test('a saved limit above 20 (25, 50) is capped at 20', () => {
  assert.deepEqual(smtpQuotaForProfile(50, 0), { dailyLimit: 20, remaining: 20, blocked: false });
  assert.deepEqual(smtpQuotaForProfile(25, 5), { dailyLimit: 20, remaining: 15, blocked: false });
});

test('a lower limit is kept and sends are counted down', () => {
  assert.deepEqual(smtpQuotaForProfile(10, 3), { dailyLimit: 10, remaining: 7, blocked: false });
  assert.deepEqual(smtpQuotaForProfile(20, 12), { dailyLimit: 20, remaining: 8, blocked: false });
});

test('remaining never goes below 0', () => {
  assert.equal(smtpQuotaForProfile(20, 25).remaining, 0);
  assert.equal(smtpQuotaForProfile(null, 20).remaining, 0);
});

test('limit 0 = sending is off (was shown as "Unlimited today")', () => {
  assert.deepEqual(smtpQuotaForProfile(0, 0), { dailyLimit: 0, remaining: 0, blocked: true });
});

test('the screens and the email worker always agree', () => {
  for (const limit of [null, undefined, 0, 1, 10, 19, 20, 21, 25, 50, 1000]) {
    for (const sent of [0, 1, 10, 19, 20, 30]) {
      const worker = remainingSmtpQuota(limit, sent);
      const screen = smtpQuotaForProfile(limit, sent).remaining;
      assert.equal(screen, worker ?? Infinity, `limit ${limit}, sent ${sent}`);
    }
  }
  assert.notEqual(interpretSmtpDailyLimit(null), 'unlimited');
});
