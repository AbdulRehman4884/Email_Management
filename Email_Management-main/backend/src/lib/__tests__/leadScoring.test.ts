/**
 * Run: npm run test:scoring   (node:test through tsx, no database needed)
 * Covers the lead score of CRM step 7.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WEIGHTS, computeScore, diffBreakdown, normalizeWeights, tierFor, type ScoreFacts } from '../crm/leadScoring.js';

const facts = (over: Partial<ScoreFacts> = {}): ScoreFacts => ({
  openCount: 0, replyCount: 0, lastLabel: null, followUpsSinceReply: 0, daysInactive: 0, tags: [], customFields: null, rulePoints: 0, ...over,
});
const W = DEFAULT_WEIGHTS;

test('opens give +5 each, at most +15', () => {
  assert.equal(computeScore(facts({ openCount: 1 }), W).score, 5);
  assert.equal(computeScore(facts({ openCount: 3 }), W).score, 15);
  assert.equal(computeScore(facts({ openCount: 9 }), W).score, 15);
});

test('reply + label: Interested reply = 20 + 40', () => {
  const r = computeScore(facts({ replyCount: 1, lastLabel: 'interested', openCount: 2 }), W);
  assert.equal(r.score, 70);
  assert.equal(r.tier, 'hot');
  assert.deepEqual(r.breakdown.map((b) => [b.key, b.points]), [['opens', 10], ['replies', 20], ['label', 40]]);
});

test('labels use the default weights', () => {
  const s = (lastLabel: string) => computeScore(facts({ replyCount: 1, lastLabel }), W).raw;
  assert.equal(s('question'), 45);
  assert.equal(s('meeting_booked'), 70);
  assert.equal(s('neutral'), 25);
  assert.equal(s('out_of_office'), 20);
  assert.equal(s('not_interested'), -30);
  assert.equal(s('bounce_unsubscribe'), -80);
});

test('score is clamped to 0..100', () => {
  assert.equal(computeScore(facts({ replyCount: 1, lastLabel: 'not_interested' }), W).score, 0);
  assert.equal(computeScore(facts({ replyCount: 4, lastLabel: 'meeting_booked', openCount: 5 }), W).score, 100);
});

test('follow-ups with no reply: -5 each; no activity: -10 per full 14 days', () => {
  const r = computeScore(facts({ openCount: 3, followUpsSinceReply: 2, daysInactive: 29 }), W);
  assert.equal(r.raw, 15 - 10 - 20);
  assert.equal(r.score, 0);
  assert.equal(computeScore(facts({ openCount: 3, daysInactive: 13.9 }), W).score, 15, 'less than 14 days: nothing');
  assert.equal(computeScore(facts({ openCount: 3, daysInactive: 14 }), W).score, 5);
});

test('tag and custom field points', () => {
  const w = normalizeWeights({ tags: { '7': 15 }, custom_fields: [{ field: 'Industry', equals: 'real estate', points: 10 }] }).weights;
  const r = computeScore(facts({ tags: [{ id: 7, name: 'VIP' }, { id: 8, name: 'Other' }], customFields: { industry: ' Real Estate ' } }), w);
  assert.equal(r.score, 25);
  assert.deepEqual(r.breakdown.map((b) => b.label), ['Tag: VIP', 'Industry = real estate']);
  assert.equal(computeScore(facts({ customFields: { industry: 'Retail' } }), w).score, 0);
});

test('rule points are part of the score', () => {
  assert.equal(computeScore(facts({ openCount: 1, rulePoints: 30 }), W).score, 35);
});

test('tier uses the thresholds', () => {
  assert.equal(tierFor(70), 'hot');
  assert.equal(tierFor(69), 'warm');
  assert.equal(tierFor(40), 'warm');
  assert.equal(tierFor(39), 'cold');
  assert.equal(tierFor(50, 50, 20), 'hot');
  assert.equal(computeScore(facts({ openCount: 3 }), W, { hot: 30, warm: 10 }).tier, 'warm');
});

test('weights: defaults, merge, and errors in strict mode', () => {
  assert.deepEqual(normalizeWeights({}).weights, DEFAULT_WEIGHTS);
  const n = normalizeWeights({ email_opened: 3, labels: { interested: 60 } });
  assert.equal(n.weights.email_opened, 3);
  assert.equal(n.weights.labels.interested, 60);
  assert.equal(n.weights.labels.question, 25);
  assert.deepEqual(normalizeWeights({ email_opened: 500 }).errors, [], 'stored data: bad values ignored');
  assert.ok(normalizeWeights({ email_opened: 500 }, true).errors[0]!.startsWith('Email opened'));
  assert.ok(normalizeWeights({ labels: { interested: 1.5 } }, true).errors.length === 1);
  assert.ok(normalizeWeights({ tags: { abc: 5 } }, true).errors.length === 1);
  assert.ok(normalizeWeights({ custom_fields: [{ field: '', equals: 'x', points: 1 }] }, true).errors.length === 1);
});

test('score events: one per changed part, rules skipped', () => {
  const before = computeScore(facts({ openCount: 1 }), W).breakdown;
  const after = computeScore(facts({ openCount: 2, replyCount: 1, lastLabel: 'interested', rulePoints: 5 }), W).breakdown;
  assert.deepEqual(diffBreakdown(before, after), [
    { points: 5, reason: 'Opened 2 emails (was +5)', source: 'open' },
    { points: 20, reason: '1 reply', source: 'reply' },
    { points: 40, reason: 'Latest reply: Interested', source: 'label' },
  ]);
  assert.deepEqual(diffBreakdown(after, after), []);
  assert.deepEqual(diffBreakdown(after, []).find((e) => e.source === 'label'), { points: -40, reason: 'No longer: Latest reply: Interested', source: 'label' });
});
