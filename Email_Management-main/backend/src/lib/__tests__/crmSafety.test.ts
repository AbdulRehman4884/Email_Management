/**
 * Run: npm run test:safety   (node:test through tsx, no database needed)
 * CRM step 9: the background queue that keeps CRM work from slowing down sending and the IMAP worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crmBackgroundIdle, crmBackgroundStats, runCrmInBackground } from '../crm/backgroundQueue.js';
import { MAX_MOVES_PER_EVENT, MAX_RULE_FOLLOW_UPS_PER_LEAD } from '../crm/ruleEngine.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('queue: the caller never waits, and only a few jobs run at once', async () => {
  let running = 0;
  let peak = 0;
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    runCrmInBackground(`job ${i}`, async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(2);
      running--;
      done++;
    });
  }
  assert.ok(Date.now() - t0 < 50, 'adding 200 jobs returns at once');
  assert.equal(done, 0, 'nothing ran inside the caller');
  await crmBackgroundIdle();
  assert.equal(done, 200);
  assert.ok(peak <= crmBackgroundStats().concurrency, `peak ${peak} <= ${crmBackgroundStats().concurrency}`);
  assert.ok(peak >= 1);
});

test('queue: jobs start in order, and a failing job does not stop the others', async () => {
  const order: number[] = [];
  const errors = console.error;
  console.error = () => {}; // the failing job is logged; keep the test output clean
  try {
    for (let i = 0; i < 20; i++) {
      runCrmInBackground(`job ${i}`, async () => {
        order.push(i);
        if (i % 5 === 0) throw new Error('boom');
      });
    }
    await crmBackgroundIdle();
  } finally {
    console.error = errors;
  }
  assert.deepEqual(order, [...Array(20).keys()]);
  assert.deepEqual(crmBackgroundStats().waiting, 0);
});

test('rule engine limits are in place', () => {
  assert.equal(MAX_MOVES_PER_EVENT, 3);
  assert.equal(MAX_RULE_FOLLOW_UPS_PER_LEAD, 5);
});
