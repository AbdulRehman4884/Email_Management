/**
 * Plan limits: Basic 5 / Standard 100 / Premium unlimited SMTP profiles; prices $9.99 (F-04) / $24.99 / $49.99;
 * and 20 emails/day per SMTP account on every plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS_SEED, SMTP_PROFILES_UNLIMITED, isUnlimitedSmtpProfiles } from '../planCatalog';
import { SMTP_DAILY_EMAIL_LIMIT_MAX } from '../../constants/fieldLimits';
import { smtpQuotaForProfile } from '../dailySendQuota';

const plan = (code: string) => PLANS_SEED.find((p) => p.code === code)!;

test('SMTP profile limits per plan', () => {
  assert.equal(plan('basic').smtpLimit, 5);
  assert.equal(plan('standard').smtpLimit, 100);
  assert.equal(plan('premium').smtpLimit, SMTP_PROFILES_UNLIMITED);
  assert.equal(isUnlimitedSmtpProfiles(plan('premium').smtpLimit), true);
  assert.equal(isUnlimitedSmtpProfiles(plan('standard').smtpLimit), false);
});

test('prices (F-04: Basic is no longer the $0.10 test price)', () => {
  assert.equal(plan('basic').priceUsd, '9.99');
  assert.equal(plan('standard').priceUsd, '24.99');
  assert.equal(plan('premium').priceUsd, '49.99');
});

test('every plan: 20 emails/day per SMTP account, and the worker cap stays 20', () => {
  for (const p of PLANS_SEED) assert.equal(p.dailyEmailLimit, SMTP_DAILY_EMAIL_LIMIT_MAX);
  assert.equal(SMTP_DAILY_EMAIL_LIMIT_MAX, 20);
  assert.equal(smtpQuotaForProfile(null, 0).dailyLimit, 20);
});

test('profile-limit check: count >= limit blocks; unlimited never blocks', () => {
  const blocked = (count: number, limit: number) => count >= limit;
  assert.equal(blocked(4, plan('basic').smtpLimit), false);
  assert.equal(blocked(5, plan('basic').smtpLimit), true);
  assert.equal(blocked(99, plan('standard').smtpLimit), false);
  assert.equal(blocked(100, plan('standard').smtpLimit), true);
  assert.equal(blocked(5000, plan('premium').smtpLimit), false);
});
