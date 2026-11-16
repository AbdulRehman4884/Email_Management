/**
 * Run: npm run test:labels   (node:test through tsx, no database needed)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReply,
  classifyReplyByRules,
  isOutOfOfficeSubject,
  normalizeHeaders,
  stripQuotedHistory,
  nonHumanReplySql,
  type ReplyToClassify,
} from '../replyLabeling.js';

function reply(body: string, extra: Partial<ReplyToClassify> = {}): ReplyToClassify {
  return { fromEmail: 'ali@shop.com', subject: 'Re: Quick idea', bodyText: body, bodyHtml: null, ...extra };
}
const label = (r: ReplyToClassify) => classifyReplyByRules(r).result.label;

test('auto-reply headers win over body words', () => {
  assert.equal(label(reply('I am interested!', { headers: { 'auto-submitted': 'auto-replied' } })), 'out_of_office');
  assert.equal(label(reply('hi', { headers: { 'x-autoreply': 'yes' } })), 'out_of_office');
  assert.equal(label(reply('hi', { headers: { precedence: 'bulk' } })), 'out_of_office');
  assert.notEqual(label(reply('hi', { headers: { 'auto-submitted': 'no' } })), 'out_of_office');
});

test('out-of-office subjects and body', () => {
  assert.equal(isOutOfOfficeSubject('Automatic reply: Quick idea'), true);
  assert.equal(isOutOfOfficeSubject('OOO: back Monday'), true);
  assert.equal(isOutOfOfficeSubject('Re: Quick idea'), false);
  assert.equal(label(reply('Thanks', { subject: 'Out of Office: until 5 Nov' })), 'out_of_office');
  assert.equal(label(reply("I'm out of the office until Monday with limited access to email.")), 'out_of_office');
});

test('bounces and unsubscribe requests', () => {
  assert.equal(label(reply('Delivery failed', { fromEmail: 'MAILER-DAEMON@mx.google.com' })), 'bounce_unsubscribe');
  assert.equal(label(reply('undeliverable', { fromEmail: 'Postmaster <postmaster@outlook.com>' })), 'bounce_unsubscribe');
  assert.equal(label(reply('Please remove me from your list')), 'bounce_unsubscribe');
  assert.equal(label(reply('Stop emailing me.')), 'bounce_unsubscribe');
  assert.equal(label(reply('Unsubscribe')), 'bounce_unsubscribe');
  assert.equal(label(reply('mujhe dobara email mat karein')), 'bounce_unsubscribe');
});

test('meeting booked', () => {
  assert.equal(label(reply('Sure, grab a time here: https://calendly.com/ali/30min')), 'meeting_booked');
  assert.equal(label(reply('Can we book a call for Thursday?')), 'meeting_booked');
  assert.equal(label(reply('Theek hai, kal meeting rakh lete hain')), 'meeting_booked');
});

test('not interested beats interested', () => {
  assert.equal(label(reply('We are not interested, thanks.')), 'not_interested');
  assert.equal(label(reply('No thanks, we already have a vendor.')), 'not_interested');
  assert.equal(label(reply('Abhi humein iski zaroorat nahi')), 'not_interested');
  assert.equal(label(reply('Hum interested nahi hain')), 'not_interested');
});

test('interested', () => {
  assert.equal(label(reply('Sounds good, tell me more.')), 'interested');
  assert.equal(label(reply("Yes please, I'm interested.")), 'interested');
  assert.equal(label(reply('Ji haan bilkul, details bhejein')), 'interested');
});

test('question and neutral', () => {
  assert.equal(label(reply('How much does it cost per month?')), 'question');
  assert.equal(label(reply('Iski price kya hai?')), 'question');
  assert.equal(label(reply('Thanks for the email.')), 'neutral');
  assert.equal(label(reply('')), 'neutral');
});

test('quoted history is ignored', () => {
  const body = 'No thanks.\n\nOn Tue, 1 Oct 2026 at 10:00, Sam <sam@acme.com> wrote:\n> Are you interested in a call? calendly.com/sam';
  assert.equal(stripQuotedHistory(body), 'No thanks.');
  assert.equal(label(reply(body)), 'not_interested');
  const outlook = 'Interested.\n\nFrom: Sam <sam@acme.com>\nSent: Tuesday\nSubject: unsubscribe';
  assert.equal(label(reply(outlook)), 'interested');
});

test('html body is used when there is no text body', () => {
  assert.equal(label(reply('', { bodyText: null, bodyHtml: '<p>Sounds great!</p><blockquote>unsubscribe</blockquote>' })), 'interested');
});

test('header normalisation', () => {
  assert.deepEqual(normalizeHeaders('Auto-Submitted: auto-replied\nX-Test: a\n b'), { 'auto-submitted': 'auto-replied', 'x-test': 'a b' });
  assert.deepEqual(normalizeHeaders(new Map([['Precedence', 'bulk']])), { precedence: 'bulk' });
  assert.deepEqual(normalizeHeaders({ 'X-Autoreply': 'yes' }), { 'x-autoreply': 'yes' });
  assert.deepEqual(normalizeHeaders(null), {});
});

test('AI is skipped without a key and keyword result is kept', async () => {
  const before = process.env.AI_LABELING_API_KEY;
  delete process.env.AI_LABELING_API_KEY;
  const r = await classifyReply(reply('Sounds good'), { aiEnabled: true });
  assert.deepEqual([r.label, r.source], ['interested', 'keyword']);
  if (before !== undefined) process.env.AI_LABELING_API_KEY = before;
});

test('AI failure falls back to keywords', async () => {
  const before = { key: process.env.AI_LABELING_API_KEY, url: process.env.AI_LABELING_BASE_URL };
  process.env.AI_LABELING_API_KEY = 'test-key';
  process.env.AI_LABELING_BASE_URL = 'http://127.0.0.1:9'; // nothing listens here
  const r = await classifyReply(reply('No thanks'), { aiEnabled: true });
  assert.deepEqual([r.label, r.source], ['not_interested', 'keyword']);
  process.env.AI_LABELING_API_KEY = before.key;
  process.env.AI_LABELING_BASE_URL = before.url;
  if (before.key === undefined) delete process.env.AI_LABELING_API_KEY;
  if (before.url === undefined) delete process.env.AI_LABELING_BASE_URL;
});

test('shared reply-count SQL keeps the old rules', () => {
  const sql = nonHumanReplySql('er');
  for (const part of ["'%out of office%'", "'ooo:%'", "'noreply'", "'mailer-daemon+%'", "POSITION('postmaster'"]) {
    assert.ok(sql.includes(part), part);
  }
});
