/**
 * Checks rules sent by the Pipeline Builder (step 4) before they are saved. Pure, unit tested.
 * Returns a cleaned rule or a list of plain-English errors.
 */
import { CONDITION_FIELDS, CONDITION_OPERATORS, isGroup, type ConditionGroup, type ConditionLeaf } from './conditions.js';
import type { CrmEventType } from './events.js';
import { REPLY_LABELS } from '../../constants/replyLabels.js';

export const RULE_TRIGGERS: CrmEventType[] = [
  'email_sent',
  'email_delivered',
  'email_opened',
  'reply_received',
  'reply_labeled',
  'bounced',
  'unsubscribed',
  'follow_up_sent',
  'manual_move',
  'time_tick',
];

export const RULE_ACTION_TYPES = [
  'move_to_stage',
  'add_tag',
  'remove_tag',
  'stop_follow_ups',
  'schedule_follow_up',
  'notify_user',
  'add_score',
] as const;

const MAX_DEPTH = 5;
const MAX_CONDITIONS = 50;
const MAX_ACTIONS = 10;
const CUSTOM_FIELD_RE = /^custom_field\.[A-Za-z0-9 _.\-]{1,64}$/;

export interface RuleContext {
  /** Stage ids of this pipeline. */
  stageIds: Set<number>;
  /** Tag ids that belong to the user. */
  tagIds: Set<number>;
}

export interface CleanRule {
  name: string;
  trigger: CrmEventType;
  fromStageId: number | null;
  priority: number;
  isActive: boolean;
  forwardOnly: boolean;
  conditions: ConditionGroup;
  actions: Array<Record<string, unknown>>;
}

type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

function cleanValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 500);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => (typeof x === 'number' ? x : String(x).slice(0, 200)));
  return String(v).slice(0, 500);
}

/** The names the rule editor shows (web/src/lib/crmRules.ts), so errors read like the form (PB-06). */
const FIELD_LABELS: Record<string, string> = {
  reply_label: 'Reply label',
  reply_count: 'Number of replies',
  open_count: 'Number of opens',
  follow_up_count: 'Number of follow-ups sent',
  days_since_last_outbound: 'Days since last email sent',
  days_since_last_reply: 'Days since last reply',
  days_in_stage: 'Days in current stage',
  reply_text_contains: 'Reply text',
  has_tag: 'Tag',
  score: 'Lead score',
  campaign_id: 'Campaign ID',
  current_stage: 'Current stage',
};
const fieldLabel = (field: string) =>
  field.startsWith('custom_field.') ? `Custom field "${field.slice('custom_field.'.length)}"` : FIELD_LABELS[field] ?? field;

/** Whole numbers and their allowed range per number field (PB-03). */
const NUMBER_RANGES: Record<string, { min: number; max: number }> = {
  reply_count: { min: 0, max: 100000 },
  open_count: { min: 0, max: 100000 },
  follow_up_count: { min: 0, max: 100000 },
  days_since_last_outbound: { min: 0, max: 3650 },
  days_since_last_reply: { min: 0, max: 3650 },
  days_in_stage: { min: 0, max: 3650 },
  score: { min: 0, max: 100 },
  campaign_id: { min: 1, max: 2147483647 },
};

const isWhole = (v: unknown, min: number, max: number) =>
  (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;

/** PB-03: a value the condition can actually match. Returns an error in form words, or null. */
function checkValue(field: string, operator: string, value: unknown, ctx: RuleContext | undefined): string | null {
  const name = fieldLabel(field);
  const list = operator === 'in' ? (Array.isArray(value) ? value : [value]) : [value];
  if (operator === 'in' && list.length === 0) return `${name}: pick at least one value`;
  const range = NUMBER_RANGES[field];
  if (range) {
    if (!list.every((v) => isWhole(v, range.min, range.max))) {
      return range.min === 1 ? `${name}: enter a campaign ID (a whole number)` : `${name}: enter a whole number from ${range.min} to ${range.max}`;
    }
    return null;
  }
  if (field === 'reply_label') {
    if (!list.every((v) => typeof v === 'string' && (REPLY_LABELS as readonly string[]).includes(v))) {
      return `${name}: pick one of the labels (Interested, Not Interested, Out of Office, Question, Meeting Booked, Neutral, Bounce / Unsubscribe)`;
    }
    return null;
  }
  if (field === 'current_stage' && ctx) {
    if (!list.every((v) => ctx.stageIds.has(Number(v)))) return `${name}: pick a stage of this pipeline`;
    return null;
  }
  if (field === 'has_tag' && ctx) {
    // A tag id must be one of the user's tags; a tag name (text) is allowed as before.
    if (!list.every((v) => (typeof v === 'string' && v.trim() !== '' && !/^\d+$/.test(v.trim())) || ctx.tagIds.has(Number(v)))) {
      return `${name}: pick one of your tags`;
    }
    return null;
  }
  return null;
}

export function validateConditions(raw: unknown, errors: string[], ctx?: RuleContext): ConditionGroup {
  let count = 0;
  // Paths read like "Condition 2" or "Condition 3.1" (inside a group).
  const walk = (g: unknown, depth: number, path: string): ConditionGroup => {
    if (g === null || g === undefined) return { op: 'AND', items: [] };
    if (!isGroup(g)) {
      errors.push(`${path || 'Conditions'}: must be a group like { "op": "AND", "items": [...] }`);
      return { op: 'AND', items: [] };
    }
    if (depth > MAX_DEPTH) {
      errors.push(`${path || 'Conditions'}: groups can be nested at most ${MAX_DEPTH} levels`);
      return { op: 'AND', items: [] };
    }
    const op = String(g.op ?? 'AND').toUpperCase();
    if (op !== 'AND' && op !== 'OR') errors.push(`${path || 'Conditions'}: op must be AND or OR`);
    const items: Array<ConditionLeaf | ConditionGroup> = [];
    (g.items ?? []).forEach((item, i) => {
      const p = path ? `${path}.${i + 1}` : `Condition ${i + 1}`;
      if (isGroup(item)) {
        items.push(walk(item, depth + 1, p));
        return;
      }
      count++;
      const leaf = item as ConditionLeaf;
      const field = String(leaf?.field ?? '');
      const operator = String(leaf?.operator ?? '');
      const knownField = (CONDITION_FIELDS as readonly string[]).includes(field) || CUSTOM_FIELD_RE.test(field);
      if (!knownField) errors.push(`${p}: unknown field "${field}"`);
      if (!(CONDITION_OPERATORS as readonly string[]).includes(operator)) {
        errors.push(`${p}: unknown operator "${operator}"`);
      }
      if (operator !== 'exists' && (leaf?.value === undefined || leaf?.value === null || leaf?.value === '')) {
        // PB-06: the field name as the form shows it, not the database key.
        errors.push(`${p} – ${fieldLabel(field)}: enter a value`);
      } else if (knownField && operator !== 'exists') {
        const bad = checkValue(field, operator, leaf?.value, ctx);
        if (bad) errors.push(`${p} – ${bad}`);
      }
      items.push({ field, operator, ...(leaf?.value !== undefined ? { value: cleanValue(leaf.value) } : {}) });
    });
    return { op: op === 'OR' ? 'OR' : 'AND', items };
  };
  const out = walk(raw, 1, '');
  if (count > MAX_CONDITIONS) errors.push(`Conditions: at most ${MAX_CONDITIONS} conditions per rule`);
  return out;
}

export function validateActions(raw: unknown, ctx: RuleContext, errors: string[]): Array<Record<string, unknown>> {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('Add at least one action');
    return [];
  }
  if (raw.length > MAX_ACTIONS) errors.push(`At most ${MAX_ACTIONS} actions per rule`);
  const out: Array<Record<string, unknown>> = [];
  let moves = 0;
  raw.slice(0, MAX_ACTIONS).forEach((a, i) => {
    const p = `Action ${i + 1}`;
    const type = String((a as Record<string, unknown>)?.type ?? '');
    const act = (a ?? {}) as Record<string, unknown>;
    switch (type) {
      case 'move_to_stage': {
        moves++;
        const stageId = Number(act.stageId);
        if (!ctx.stageIds.has(stageId)) errors.push(`${p}: pick a stage of this pipeline`);
        out.push({ type, stageId });
        break;
      }
      case 'add_tag':
      case 'remove_tag': {
        const tagId = Number(act.tagId);
        if (!ctx.tagIds.has(tagId)) errors.push(`${p}: pick one of your tags`);
        out.push({ type, tagId });
        break;
      }
      case 'stop_follow_ups':
        out.push({ type });
        break;
      case 'schedule_follow_up': {
        const days = Number(act.afterDays);
        if (!Number.isInteger(days) || days < 0 || days > 365) errors.push(`${p}: days must be a whole number from 0 to 365`);
        const templateId = act.templateId == null || String(act.templateId).trim() === '' ? null : String(act.templateId).trim().slice(0, 64);
        out.push({ type, afterDays: days, templateId });
        break;
      }
      case 'notify_user': {
        const message = String(act.message ?? '').trim();
        if (!message) errors.push(`${p}: write the notification message`);
        out.push({ type, message: message.slice(0, 500) });
        break;
      }
      case 'add_score': {
        const points = Number(act.points);
        if (!Number.isInteger(points) || points === 0 || points < -100 || points > 100) {
          errors.push(`${p}: points must be a whole number from -100 to 100 (not 0)`);
        }
        out.push({ type, points });
        break;
      }
      default:
        errors.push(`${p}: unknown action "${type}"`);
    }
  });
  if (moves > 1) errors.push('A rule can move to only one stage');
  return out;
}

/**
 * Full rule check. `partial` = PATCH: only the fields sent are checked, `base` fills the rest.
 */
export function validateRuleInput(input: Record<string, unknown>, ctx: RuleContext, base?: CleanRule): Result<CleanRule> {
  const errors: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);

  const trigger = (has('trigger') ? String(input.trigger ?? '') : base?.trigger ?? '') as CrmEventType;
  if (!RULE_TRIGGERS.includes(trigger)) errors.push(`Trigger: must be one of ${RULE_TRIGGERS.join(', ')}`);

  let name = has('name') ? String(input.name ?? '').trim() : base?.name ?? '';
  if (!name) name = `When ${trigger.replace(/_/g, ' ')}`;
  if (name.length > 255) errors.push('Name: at most 255 characters');

  let fromStageId = base?.fromStageId ?? null;
  if (has('fromStageId')) {
    const v = intOrNull(input.fromStageId);
    if (v !== null && (Number.isNaN(v) || !ctx.stageIds.has(v))) errors.push('Stage: pick a stage of this pipeline, or "any stage"');
    fromStageId = v !== null && !Number.isNaN(v) ? v : null;
  } else if (fromStageId !== null && !ctx.stageIds.has(fromStageId)) {
    errors.push('Stage: pick a stage of this pipeline, or "any stage"');
  }

  let priority = base?.priority ?? 0;
  if (has('priority')) {
    const v = Number(input.priority);
    if (!Number.isInteger(v) || v < -1000 || v > 1000) errors.push('Priority: whole number from -1000 to 1000');
    else priority = v;
  }

  const isActive = has('isActive') ? input.isActive !== false : base?.isActive ?? true;
  const forwardOnly = has('forwardOnly') ? input.forwardOnly !== false : base?.forwardOnly ?? true;
  const conditions = has('conditions') ? validateConditions(input.conditions, errors, ctx) : base?.conditions ?? { op: 'AND', items: [] };
  const actions = has('actions') || !base ? validateActions(input.actions, ctx, errors) : validateActions(base.actions, ctx, errors);

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { name: name.slice(0, 255), trigger, fromStageId, priority, isActive, forwardOnly, conditions, actions } };
}
