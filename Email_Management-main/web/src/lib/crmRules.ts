/**
 * Pipeline Builder (CRM step 4): names for triggers, fields, operators and actions, and
 * describeRule() which turns a saved rule into a readable sentence.
 * Field/operator keys must match backend/src/lib/crm/conditions.ts.
 */
import type { CrmConditionGroup, CrmConditionLeaf, CrmRule, CrmRuleAction, CrmStage, CrmTag } from './api';
import { REPLY_LABEL_META, isReplyLabel } from './replyLabels';

export const TRIGGERS: Array<{ key: string; label: string; sentence: string }> = [
  { key: 'email_sent', label: 'Email sent', sentence: 'an email is sent' },
  { key: 'email_delivered', label: 'Email delivered', sentence: 'an email is delivered' },
  { key: 'email_opened', label: 'Email opened', sentence: 'an email is opened' },
  { key: 'reply_received', label: 'Reply received', sentence: 'a reply arrives' },
  { key: 'reply_labeled', label: 'Reply labeled', sentence: 'a reply is labeled' },
  { key: 'bounced', label: 'Email bounced', sentence: 'an email bounces' },
  { key: 'unsubscribed', label: 'Unsubscribed', sentence: 'the lead unsubscribes' },
  { key: 'follow_up_sent', label: 'Follow-up sent', sentence: 'a follow-up is sent' },
  { key: 'manual_move', label: 'Moved by hand', sentence: 'you move the lead by hand' },
  { key: 'time_tick', label: 'Every 30 minutes (time check)', sentence: 'the 30-minute time check runs' },
];
export const triggerLabel = (k: string) => TRIGGERS.find((t) => t.key === k)?.label ?? k;

/** How the value input looks for a field. */
export type FieldKind = 'label' | 'number' | 'text' | 'tag' | 'stage' | 'custom';

export const FIELDS: Array<{ key: string; label: string; kind: FieldKind; unit?: string }> = [
  { key: 'reply_label', label: 'Reply label', kind: 'label' },
  { key: 'reply_count', label: 'Number of replies', kind: 'number' },
  { key: 'open_count', label: 'Number of opens', kind: 'number' },
  { key: 'follow_up_count', label: 'Number of follow-ups sent', kind: 'number' },
  { key: 'days_since_last_outbound', label: 'Days since last email sent', kind: 'number', unit: 'days' },
  { key: 'days_since_last_reply', label: 'Days since last reply', kind: 'number', unit: 'days' },
  { key: 'days_in_stage', label: 'Days in current stage', kind: 'number', unit: 'days' },
  { key: 'reply_text_contains', label: 'Reply text', kind: 'text' },
  { key: 'has_tag', label: 'Tag', kind: 'tag' },
  { key: 'score', label: 'Lead score', kind: 'number' },
  { key: 'campaign_id', label: 'Campaign ID', kind: 'number' },
  { key: 'current_stage', label: 'Current stage', kind: 'stage' },
  { key: 'custom_field', label: 'Custom field…', kind: 'custom' },
];

export const OPERATORS: Record<string, string> = {
  equals: 'is',
  not_equals: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  not_contains: 'does not contain',
  in: 'is one of',
  exists: 'is set',
};

/** Operators that make sense for each kind of field. */
export const OPERATORS_FOR: Record<FieldKind, string[]> = {
  label: ['equals', 'not_equals', 'in', 'exists'],
  number: ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte'],
  text: ['contains', 'not_contains'],
  tag: ['equals', 'not_equals', 'exists'],
  stage: ['equals', 'not_equals'],
  custom: ['equals', 'not_equals', 'contains', 'not_contains', 'exists'],
};

export function fieldMeta(key: string) {
  if (key.startsWith('custom_field.')) return FIELDS.find((f) => f.key === 'custom_field')!;
  return FIELDS.find((f) => f.key === key);
}

export const ACTION_TYPES: Array<{ key: CrmRuleAction['type']; label: string }> = [
  { key: 'move_to_stage', label: 'Move to stage' },
  { key: 'stop_follow_ups', label: 'Stop follow-ups' },
  { key: 'notify_user', label: 'Notify me' },
  { key: 'schedule_follow_up', label: 'Schedule a follow-up' },
  { key: 'add_tag', label: 'Add tag' },
  { key: 'remove_tag', label: 'Remove tag' },
  { key: 'add_score', label: 'Add score points' },
];

export function newAction(type: CrmRuleAction['type'], stages: CrmStage[], tags: CrmTag[]): CrmRuleAction {
  switch (type) {
    case 'move_to_stage': return { type, stageId: stages[0]?.id ?? 0 };
    case 'add_tag':
    case 'remove_tag': return { type, tagId: tags[0]?.id ?? 0 };
    case 'stop_follow_ups': return { type };
    case 'schedule_follow_up': return { type, afterDays: 3, templateId: null };
    case 'notify_user': return { type, message: '{{name}} needs attention' };
    case 'add_score': return { type, points: 10 };
  }
}

export function isGroup(item: unknown): item is CrmConditionGroup {
  return !!item && typeof item === 'object' && Array.isArray((item as CrmConditionGroup).items);
}

// ─── sentences ─────────────────────────────────────────────────────────────

interface Names {
  stages: CrmStage[];
  tags: CrmTag[];
}

function valueText(field: string, value: unknown, names: Names): string {
  const list = Array.isArray(value) ? value : [value];
  const one = (v: unknown) => {
    if (field === 'reply_label' && isReplyLabel(v)) return REPLY_LABEL_META[v].name;
    if (field === 'current_stage') return names.stages.find((s) => s.id === Number(v))?.name ?? String(v);
    if (field === 'has_tag') return names.tags.find((t) => t.id === Number(v))?.name ?? String(v);
    return typeof v === 'string' ? `"${v}"` : String(v);
  };
  return list.map(one).join(' or ');
}

export function describeLeaf(leaf: CrmConditionLeaf, names: Names): string {
  const meta = fieldMeta(leaf.field);
  const field = leaf.field.startsWith('custom_field.') ? `custom field "${leaf.field.slice(13)}"` : (meta?.label ?? leaf.field).toLowerCase();
  const op = OPERATORS[leaf.operator] ?? leaf.operator;
  if (leaf.operator === 'exists') return `${field} ${leaf.value === false ? 'is empty' : 'is set'}`;
  return `${field} ${op} ${valueText(leaf.field, leaf.value, names)}`;
}

export function describeConditions(group: CrmConditionGroup | null | undefined, names: Names, nested = false): string {
  if (!group || group.items.length === 0) return '';
  const parts = group.items.map((it) => (isGroup(it) ? describeConditions(it, names, true) : describeLeaf(it, names)));
  const joined = parts.join(group.op === 'OR' ? ' or ' : ' and ');
  return nested && parts.length > 1 ? `(${joined})` : joined;
}

export function describeAction(a: CrmRuleAction, names: Names): string {
  switch (a.type) {
    case 'move_to_stage': return `move to ${names.stages.find((s) => s.id === a.stageId)?.name ?? 'a deleted stage'}`;
    case 'add_tag': return `add tag ${names.tags.find((t) => t.id === a.tagId)?.name ?? '?'}`;
    case 'remove_tag': return `remove tag ${names.tags.find((t) => t.id === a.tagId)?.name ?? '?'}`;
    case 'stop_follow_ups': return 'stop follow-ups';
    case 'schedule_follow_up': return `send a follow-up after ${a.afterDays} day${a.afterDays === 1 ? '' : 's'}`;
    case 'notify_user': return 'notify me';
    case 'add_score': return `${a.points > 0 ? 'add' : 'remove'} ${Math.abs(a.points)} score points`;
  }
}

/** Parts of the sentence, so the UI can highlight them. */
export function describeRule(rule: Pick<CrmRule, 'trigger' | 'conditions' | 'actions' | 'fromStageId'>, names: Names) {
  const when = TRIGGERS.find((t) => t.key === rule.trigger)?.sentence ?? rule.trigger;
  const from = rule.fromStageId ? names.stages.find((s) => s.id === rule.fromStageId)?.name ?? null : null;
  const cond = describeConditions(rule.conditions, names);
  const then = rule.actions.map((a) => describeAction(a, names));
  const thenText = then.length > 1 ? `${then.slice(0, -1).join(', ')} and ${then[then.length - 1]}` : then[0] ?? 'do nothing';
  return { when, from, cond, then: thenText };
}

/** Rules shown for a stage: rules that bring leads into it, and rules that only apply while a lead is in it. */
export function rulesForStage(rules: CrmRule[], stageId: number) {
  const into = rules.filter((r) => r.actions.some((a) => a.type === 'move_to_stage' && a.stageId === stageId));
  const whileIn = rules.filter((r) => r.fromStageId === stageId && !into.includes(r));
  return { into, whileIn };
}
