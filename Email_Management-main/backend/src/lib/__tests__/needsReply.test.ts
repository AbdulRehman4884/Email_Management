/**
 * Run: npm run test:reminders   (node:test through tsx, no database needed)
 * Covers the "needs reply" helpers of CRM step 6.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigestEmail, isPriorityLabel, reminderDueHours, waitingText, type WaitingLead } from '../crm/needsReply.js';

test('Interested and Question are reminded after half the hours', () => {
  assert.equal(reminderDueHours(24, false), 24);
  assert.equal(reminderDueHours(24, true), 12);
  assert.equal(reminderDueHours(5, true), 2.5);
  assert.equal(reminderDueHours(0, false), 24, 'bad setting falls back to 24h');
  assert.equal(isPriorityLabel('interested'), true);
  assert.equal(isPriorityLabel('question'), true);
  assert.equal(isPriorityLabel('neutral'), false);
  assert.equal(isPriorityLabel(null), false);
});

test('waiting text reads like a person would say it', () => {
  assert.equal(waitingText(0.2), 'waiting 12 min');
  assert.equal(waitingText(0.001), 'waiting 1 min');
  assert.equal(waitingText(1), 'waiting 1 hour');
  assert.equal(waitingText(5.9), 'waiting 5 hours');
  assert.equal(waitingText(47), 'waiting 47 hours');
  assert.equal(waitingText(49), 'waiting 2 days');
  assert.equal(waitingText(24 * 10), 'waiting 10 days');
  assert.equal(waitingText(Number.NaN), 'waiting');
});

const lead = (over: Partial<WaitingLead>): WaitingLead => ({
  contactId: 1, email: 'a@b.com', name: null, company: null, score: 10, scoreTier: 'cold', stageName: null, stageColor: null,
  since: '2026-01-01T00:00:00Z', waitingHours: 30, dueHours: 24, overdue: true, priority: 'normal', snoozedUntil: null,
  reminded: false, replyId: 5, threadRootId: 5, label: 'question', subject: 'Re: hi', snippet: 'How much?', ...over,
});

test('digest email lists every lead, escapes HTML and links to the Inbox', () => {
  const mail = buildDigestEmail(
    [lead({ name: 'Ali <script>', score: 50 }), lead({ email: 'x@y.com', label: 'interested', snippet: '' })],
    'https://app.test/'
  );
  assert.equal(mail.subject, '2 leads are waiting for your reply');
  assert.ok(mail.html.includes('Ali &lt;script&gt;'));
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.html.includes('https://app.test/inbox?tab=needs_reply'));
  assert.ok(mail.text.includes('x@y.com · waiting 30 hours · Interested · score 10'));
  assert.equal(buildDigestEmail([lead({})], null).subject, '1 lead is waiting for your reply');
});
