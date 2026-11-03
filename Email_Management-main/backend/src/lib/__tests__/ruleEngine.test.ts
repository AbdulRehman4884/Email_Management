/**
 * Run: npm run test:rules   (node:test through tsx, no database needed)
 * Covers condition evaluation and the forwardOnly / manualOnly move policy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConditions, evaluateLeaf, usesTimeFields, type ContactFacts } from '../crm/conditions.js';
import { canAutoMove, type StageInfo } from '../crm/movePolicy.js';
import { DEFAULT_RULES, DEFAULT_STAGES } from '../crm/pipelines.js';

function facts(over: Partial<ContactFacts> = {}): ContactFacts {
  return {
    reply_label: null,
    reply_count: 0,
    open_count: 0,
    follow_up_count: 0,
    days_since_last_outbound: null,
    days_since_last_reply: null,
    days_in_stage: 1,
    reply_text: '',
    tags: [],
    score: 0,
    campaign_ids: [7],
    current_stage_id: 2,
    current_stage_name: 'contacted',
    custom_fields: {},
    ...over,
  };
}

const stage = (id: number, position: number, extra: Partial<StageInfo> = {}): StageInfo => ({
  id, name: `S${id}`, position, type: 'normal', manualOnly: false, stopFollowUps: false, ...extra,
});

// ── conditions ──────────────────────────────────────────────────────────────

test('empty conditions always match', () => {
  assert.equal(evaluateConditions(null, facts()), true);
  assert.equal(evaluateConditions({ op: 'AND', items: [] }, facts()), true);
  assert.equal(evaluateConditions({ op: 'OR', items: [] }, facts()), true);
});

test('number operators', () => {
  const f = facts({ open_count: 2, score: 55 });
  assert.equal(evaluateLeaf({ field: 'open_count', operator: 'gte', value: 2 }, f), true);
  assert.equal(evaluateLeaf({ field: 'open_count', operator: 'gt', value: 2 }, f), false);
  assert.equal(evaluateLeaf({ field: 'score', operator: 'lt', value: '60' }, f), true);
  assert.equal(evaluateLeaf({ field: 'score', operator: 'lte', value: 55 }, f), true);
  assert.equal(evaluateLeaf({ field: 'score', operator: 'equals', value: '55' }, f), true);
  // never happened (null) never satisfies gt/lt
  assert.equal(evaluateLeaf({ field: 'days_since_last_reply', operator: 'gte', value: 0 }, f), false);
});

test('label equals / not_equals / in / exists', () => {
  const f = facts({ reply_label: 'interested' });
  assert.equal(evaluateLeaf({ field: 'reply_label', operator: 'equals', value: 'Interested' }, f), true);
  assert.equal(evaluateLeaf({ field: 'reply_label', operator: 'not_equals', value: 'out_of_office' }, f), true);
  assert.equal(evaluateLeaf({ field: 'reply_label', operator: 'in', value: ['question', 'interested'] }, f), true);
  assert.equal(evaluateLeaf({ field: 'reply_label', operator: 'in', value: 'question, meeting_booked' }, f), false);
  assert.equal(evaluateLeaf({ field: 'reply_label', operator: 'exists' }, f), true);
  assert.equal(evaluateLeaf({ field: 'reply_label', operator: 'exists' }, facts()), false);
  assert.equal(evaluateLeaf({ field: 'reply_label', operator: 'exists', value: false }, facts()), true);
  // no label yet: equals is false, not_equals is true
  assert.equal(evaluateLeaf({ field: 'reply_label', operator: 'equals', value: 'interested' }, facts()), false);
  assert.equal(evaluateLeaf({ field: 'reply_label', operator: 'not_equals', value: 'interested' }, facts()), true);
});

test('reply text, tags, campaign, stage, custom fields', () => {
  const f = facts({
    reply_text: 'can we talk about pricing next week',
    tags: [3, 'vip'],
    campaign_ids: [7, 9],
    current_stage_id: 4,
    current_stage_name: 'replied',
    custom_fields: { Industry: 'Real Estate' },
  });
  assert.equal(evaluateLeaf({ field: 'reply_text_contains', operator: 'contains', value: 'pricing' }, f), true);
  assert.equal(evaluateLeaf({ field: 'reply_text_contains', operator: 'contains', value: ['budget', 'next week'] }, f), true);
  assert.equal(evaluateLeaf({ field: 'reply_text_contains', operator: 'not_contains', value: 'pricing' }, f), false);
  assert.equal(evaluateLeaf({ field: 'has_tag', operator: 'equals', value: 3 }, f), true);
  assert.equal(evaluateLeaf({ field: 'has_tag', operator: 'equals', value: 'VIP' }, f), true);
  assert.equal(evaluateLeaf({ field: 'has_tag', operator: 'not_equals', value: 5 }, f), true);
  assert.equal(evaluateLeaf({ field: 'has_tag', operator: 'exists' }, facts()), false);
  assert.equal(evaluateLeaf({ field: 'campaign_id', operator: 'equals', value: 9 }, f), true);
  assert.equal(evaluateLeaf({ field: 'campaign_id', operator: 'in', value: [1, 2] }, f), false);
  assert.equal(evaluateLeaf({ field: 'current_stage', operator: 'equals', value: 4 }, f), true);
  assert.equal(evaluateLeaf({ field: 'current_stage', operator: 'equals', value: 'Replied' }, f), true);
  assert.equal(evaluateLeaf({ field: 'custom_field.industry', operator: 'equals', value: 'real estate' }, f), true);
  assert.equal(evaluateLeaf({ field: 'custom_field.city', operator: 'exists' }, f), false);
});

test('unknown fields and operators never match', () => {
  assert.equal(evaluateLeaf({ field: 'nope', operator: 'equals', value: 1 }, facts()), false);
  assert.equal(evaluateLeaf({ field: 'score', operator: 'between', value: 1 }, facts()), false);
  assert.equal(evaluateLeaf({ field: 'has_tag', operator: 'gt', value: 1 }, facts({ tags: [1] })), false);
});

test('AND / OR and nested groups', () => {
  const f = facts({ follow_up_count: 3, reply_count: 0, days_since_last_outbound: 6 });
  const noReplyRule = {
    op: 'AND',
    items: [
      { field: 'follow_up_count', operator: 'gte', value: 3 },
      { field: 'reply_count', operator: 'equals', value: 0 },
      { field: 'days_since_last_outbound', operator: 'gte', value: 5 },
    ],
  };
  assert.equal(evaluateConditions(noReplyRule, f), true);
  assert.equal(evaluateConditions(noReplyRule, { ...f, days_since_last_outbound: 4.9 }), false);
  assert.equal(evaluateConditions(noReplyRule, { ...f, reply_count: 1 }), false);

  const nested = {
    op: 'OR',
    items: [
      { field: 'reply_label', operator: 'equals', value: 'interested' },
      { op: 'AND', items: [{ field: 'open_count', operator: 'gte', value: 3 }, { field: 'score', operator: 'gte', value: 50 }] },
    ],
  };
  assert.equal(evaluateConditions(nested, facts({ reply_label: 'interested' })), true);
  assert.equal(evaluateConditions(nested, facts({ open_count: 3, score: 60 })), true);
  assert.equal(evaluateConditions(nested, facts({ open_count: 3, score: 10 })), false);
});

test('time rules are detected (used by the time_tick worker)', () => {
  assert.equal(usesTimeFields({ op: 'AND', items: [{ field: 'days_in_stage', operator: 'gte', value: 3 }] }), true);
  assert.equal(usesTimeFields({ op: 'AND', items: [{ op: 'OR', items: [{ field: 'days_since_last_reply', operator: 'gt', value: 1 }] }] }), true);
  assert.equal(usesTimeFields({ op: 'AND', items: [{ field: 'score', operator: 'gt', value: 1 }] }), false);
});

// ── move policy ────────────────────────────────────────────────────────────

const contacted = stage(2, 1);
const replied = stage(4, 3);
const interested = stage(5, 4);
const won = stage(7, 6, { type: 'won' });
const lost = stage(8, 7, { type: 'lost' });

test('forwardOnly: only later stages, Won/Lost always allowed', () => {
  assert.deepEqual(canAutoMove(contacted, replied, true), { ok: true });
  assert.equal(canAutoMove(interested, replied, true).ok, false);
  assert.equal(canAutoMove(interested, replied, false).ok, true);
  assert.equal(canAutoMove(interested, lost, true).ok, true);
  assert.equal(canAutoMove(contacted, won, true).ok, true);
  assert.equal(canAutoMove(null, contacted, true).ok, true); // contact without a stage
  assert.equal(canAutoMove(replied, replied, true).ok, false); // same stage
});

test('Won/Lost are final for rules', () => {
  assert.equal(canAutoMove(lost, interested, false).ok, false);
  assert.equal(canAutoMove(won, lost, true).ok, false);
  assert.equal(canAutoMove(lost, won, false).ok, false);
});

test('manualOnly stages are never entered or left by rules', () => {
  const review = stage(10, 2, { manualOnly: true });
  assert.equal(canAutoMove(contacted, review, true).ok, false);
  assert.equal(canAutoMove(review, interested, true).ok, false);
  assert.equal(canAutoMove(review, lost, false).ok, false);
});

test('missing target stage is rejected', () => {
  assert.equal(canAutoMove(contacted, undefined, true).ok, false);
});

// ── default rules ──────────────────────────────────────────────────────────

test('default rules point at existing default stages and use known triggers', () => {
  const names = new Set(DEFAULT_STAGES.map((s) => s.name));
  const triggers = new Set(['email_sent', 'email_opened', 'reply_received', 'reply_labeled', 'unsubscribed', 'bounced', 'time_tick']);
  for (const r of DEFAULT_RULES) {
    if (r.moveTo) assert.ok(names.has(r.moveTo), `${r.name}: stage ${r.moveTo}`);
    assert.ok(triggers.has(r.trigger), `${r.name}: trigger ${r.trigger}`);
  }
  const tick = DEFAULT_RULES.find((r) => r.trigger === 'time_tick');
  assert.ok(tick && usesTimeFields(tick.conditions));
});

test('default reply rules: OOO does not move to Replied, interested does', () => {
  const repliedRule = DEFAULT_RULES.find((r) => r.trigger === 'reply_received')!;
  assert.equal(evaluateConditions(repliedRule.conditions, facts({ reply_label: 'out_of_office' })), false);
  assert.equal(evaluateConditions(repliedRule.conditions, facts({ reply_label: 'bounce_unsubscribe' })), false);
  assert.equal(evaluateConditions(repliedRule.conditions, facts({ reply_label: 'question' })), true);
  const lostRule = DEFAULT_RULES.find((r) => r.name.startsWith('Not interested'))!;
  assert.equal(evaluateConditions(lostRule.conditions, facts({ reply_label: 'not_interested' })), true);
  assert.equal(evaluateConditions(lostRule.conditions, facts({ reply_label: 'interested' })), false);
});

// ── rule validation (step 4: Pipeline Builder) ─────────────────────────────

import { validateRuleInput } from '../crm/ruleValidation.js';

const ctx = { stageIds: new Set([1, 2, 3]), tagIds: new Set([9]) };

test('valid rule is cleaned and defaults are filled', () => {
  const r = validateRuleInput(
    {
      trigger: 'reply_labeled',
      conditions: { op: 'or', items: [{ field: 'reply_label', operator: 'equals', value: 'interested' }, { field: 'custom_field.City', operator: 'exists' }] },
      actions: [{ type: 'move_to_stage', stageId: '2' }, { type: 'add_tag', tagId: 9 }, { type: 'schedule_follow_up', afterDays: 3, templateId: '' }],
    },
    ctx
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.name, 'When reply labeled');
  assert.equal(r.value.conditions.op, 'OR');
  assert.deepEqual(r.value.actions[0], { type: 'move_to_stage', stageId: 2 });
  assert.deepEqual(r.value.actions[2], { type: 'schedule_follow_up', afterDays: 3, templateId: null });
  assert.equal(r.value.forwardOnly, true);
  assert.equal(r.value.fromStageId, null);
});

test('bad rules list every problem', () => {
  const r = validateRuleInput(
    {
      trigger: 'whenever',
      fromStageId: 77,
      conditions: { op: 'XOR', items: [{ field: 'shoe_size', operator: 'gt', value: 1 }, { field: 'score', operator: 'gt' }] },
      actions: [{ type: 'move_to_stage', stageId: 5 }, { type: 'move_to_stage', stageId: 1 }, { type: 'add_score', points: 0 }, { type: 'remove_tag', tagId: 1 }, { type: 'fly' }],
    },
    ctx
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  const all = r.errors.join(' | ');
  for (const part of ['Trigger', 'Stage: pick', 'op must be AND or OR', 'Condition 1: unknown field "shoe_size"', 'Condition 2 – Lead score: enter a value', 'Action 1: pick a stage', 'only one stage', 'points', 'pick one of your tags', 'unknown action "fly"']) {
    assert.ok(all.includes(part), `missing error: ${part}`);
  }
});

test('PB-03: condition values must be ones the rule can match', () => {
  const rule = (items: unknown[]) =>
    validateRuleInput({ trigger: 'email_opened', conditions: { op: 'AND', items }, actions: [{ type: 'stop_follow_ups' }] }, ctx);
  const errs = (items: unknown[]) => {
    const r = rule(items);
    return r.ok ? '' : r.errors.join(' | ');
  };
  assert.match(errs([{ field: 'open_count', operator: 'equals', value: -3 }]), /Number of opens: enter a whole number from 0/);
  assert.match(errs([{ field: 'open_count', operator: 'gte', value: 'abc' }]), /Number of opens: enter a whole number/);
  assert.match(errs([{ field: 'days_in_stage', operator: 'gte', value: 1.5 }]), /Days in current stage: enter a whole number/);
  assert.match(errs([{ field: 'score', operator: 'gt', value: 150 }]), /Lead score: enter a whole number from 0 to 100/);
  assert.match(errs([{ field: 'reply_label', operator: 'equals', value: 'happy' }]), /Reply label: pick one of the labels/);
  assert.match(errs([{ field: 'reply_label', operator: 'in', value: ['interested', 'happy'] }]), /Reply label: pick one of the labels/);
  assert.match(errs([{ field: 'current_stage', operator: 'equals', value: 999 }]), /Current stage: pick a stage/);
  // Good values still pass (also numbers sent as text by older clients).
  assert.equal(rule([{ field: 'open_count', operator: 'gte', value: 2 }]).ok, true);
  assert.equal(rule([{ field: 'open_count', operator: 'gte', value: '2' }]).ok, true);
  assert.equal(rule([{ field: 'reply_count', operator: 'equals', value: 0 }]).ok, true);
  assert.equal(rule([{ field: 'reply_label', operator: 'in', value: ['not_interested', 'bounce_unsubscribe'] }]).ok, true);
  assert.equal(rule([{ field: 'reply_label', operator: 'exists' }]).ok, true);
  assert.equal(rule([{ field: 'custom_field.industry', operator: 'equals', value: 'SaaS' }]).ok, true);
});

test('a rule needs at least one action, and nesting is limited', () => {
  const none = validateRuleInput({ trigger: 'email_sent', actions: [] }, ctx);
  assert.equal(none.ok, false);
  let g: { op: string; items: unknown[] } = { op: 'AND', items: [{ field: 'score', operator: 'gt', value: 1 }] };
  for (let i = 0; i < 7; i++) g = { op: 'AND', items: [g] };
  const deep = validateRuleInput({ trigger: 'email_sent', conditions: g, actions: [{ type: 'stop_follow_ups' }] }, ctx);
  assert.equal(deep.ok, false);
});

test('partial update keeps the saved fields', () => {
  const base = validateRuleInput({ trigger: 'email_opened', name: 'Opens', actions: [{ type: 'move_to_stage', stageId: 3 }] }, ctx);
  assert.ok(base.ok);
  if (!base.ok) return;
  const upd = validateRuleInput({ isActive: false, priority: 7 }, ctx, base.value);
  assert.ok(upd.ok);
  if (!upd.ok) return;
  assert.deepEqual([upd.value.trigger, upd.value.name, upd.value.isActive, upd.value.priority], ['email_opened', 'Opens', false, 7]);
  assert.deepEqual(upd.value.actions, [{ type: 'move_to_stage', stageId: 3 }]);
});

test('templates: every template rule points at a stage of its template', async () => {
  const { PIPELINE_TEMPLATES } = await import('../crm/pipelines.js');
  for (const [key, t] of Object.entries(PIPELINE_TEMPLATES)) {
    const names = new Set(t.stages.map((s) => s.name));
    for (const r of t.rules) if (r.moveTo) assert.ok(names.has(r.moveTo), `${key}: ${r.name} -> ${r.moveTo}`);
  }
});
