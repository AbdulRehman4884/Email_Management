/**
 * Run: npx tsx --test src/lib/__tests__/recipientEmailCheck.test.ts   (no database, no real DNS)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSuspiciousEmails } from '../recipientEmailCheck.js';

const knownDomains = new Set(['gmail.com', 'shop.pk']);
const fakeDns = async (domain: string) => knownDomains.has(domain);

test('flags provider typos with the right domain', async () => {
  const r = await findSuspiciousEmails(['ali@gmal.com', 'sara@Hotmial.com'], fakeDns);
  assert.deepEqual(r, [
    { email: 'ali@gmal.com', reason: 'did you mean gmail.com?' },
    { email: 'sara@Hotmial.com', reason: 'did you mean hotmail.com?' },
  ]);
});

test('flags domains without a mail server, once per email', async () => {
  const r = await findSuspiciousEmails(['a@nowhere.invalid', 'b@nowhere.invalid', 'c@shop.pk'], fakeDns);
  assert.deepEqual(r.map((x) => x.email), ['a@nowhere.invalid', 'b@nowhere.invalid']);
  assert.equal(r[0]!.reason, 'domain has no mail server');
});

test('good emails, DNS errors and slow DNS are not reported', async () => {
  assert.deepEqual(await findSuspiciousEmails(['x@gmail.com', 'y@shop.pk'], fakeDns), []);
  assert.deepEqual(await findSuspiciousEmails(['z@broken.dns'], async () => { throw new Error('boom'); }), []);
  const never = () => new Promise<boolean>(() => {});
  assert.deepEqual(await findSuspiciousEmails(['w@slow.dns'], never, 50), []);
});
