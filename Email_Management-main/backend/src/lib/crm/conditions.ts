/**
 * CRM rule conditions (step 3). Pure functions, no database: easy to unit test.
 *
 * Shape stored in crm_rules.conditions:
 *   { "op": "AND" | "OR", "items": [ { "field": "...", "operator": "...", "value": ... }, <nested group>, ... ] }
 * An empty group always matches (a rule with no conditions fires on its trigger alone).
 */

export const CONDITION_FIELDS = [
  'reply_label',
  'reply_count',
  'open_count',
  'follow_up_count',
  'days_since_last_outbound',
  'days_since_last_reply',
  'days_in_stage',
  'reply_text_contains',
  'has_tag',
  'score',
  'campaign_id',
  'current_stage',
] as const;
/** Plus any `custom_field.<name>`. */
export type ConditionField = (typeof CONDITION_FIELDS)[number] | `custom_field.${string}`;

export const CONDITION_OPERATORS = [
  'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'in', 'exists',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Fields that only make sense for the time_tick worker (used to find time-based rules). */
export const TIME_FIELDS = ['days_since_last_outbound', 'days_since_last_reply', 'days_in_stage'] as const;

export interface ConditionLeaf {
  field: string;
  operator: string;
  value?: unknown;
}
export interface ConditionGroup {
  op?: 'AND' | 'OR' | string;
  items?: Array<ConditionLeaf | ConditionGroup>;
}

/**
 * Everything a condition can look at, for one contact at one moment.
 * List facts (campaign ids, tags) are arrays: equals / in / not_equals test membership.
 * Day facts are null when the thing never happened (e.g. no reply yet).
 */
export interface ContactFacts {
  reply_label: string | null;
  reply_count: number;
  open_count: number;
  follow_up_count: number;
  days_since_last_outbound: number | null;
  days_since_last_reply: number | null;
  days_in_stage: number | null;
  /** Lower-cased text of the newest inbound reply (for reply_text_contains). */
  reply_text: string;
  /** Tag ids and tag names (names lower-cased). */
  tags: Array<number | string>;
  score: number;
  /** All campaigns the contact is in (event campaign first when known). */
  campaign_ids: number[];
  /** Current stage id and its lower-cased name. */
  current_stage_id: number | null;
  current_stage_name: string | null;
  custom_fields: Record<string, string>;
}

export function isGroup(item: unknown): item is ConditionGroup {
  return !!item && typeof item === 'object' && Array.isArray((item as ConditionGroup).items);
}

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** `in` accepts an array or a comma-separated string. */
function toList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  if (v === null || v === undefined) return [];
  return [v];
}

function sameValue(a: unknown, b: unknown): boolean {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na === nb;
  return norm(a) === norm(b);
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Value(s) of a field. Returns { list } for multi-value facts, { value } otherwise, or null for unknown fields. */
function readField(field: string, facts: ContactFacts): { value: unknown } | { list: unknown[] } | null {
  switch (field) {
    case 'reply_label': return { value: facts.reply_label };
    case 'reply_count': return { value: facts.reply_count };
    case 'open_count': return { value: facts.open_count };
    case 'follow_up_count': return { value: facts.follow_up_count };
    case 'days_since_last_outbound': return { value: facts.days_since_last_outbound };
    case 'days_since_last_reply': return { value: facts.days_since_last_reply };
    case 'days_in_stage': return { value: facts.days_in_stage };
    case 'reply_text_contains': return { value: facts.reply_text };
    case 'has_tag': return { list: facts.tags };
    case 'score': return { value: facts.score };
    case 'campaign_id': return { list: facts.campaign_ids };
    case 'current_stage': {
      const list: unknown[] = [];
      if (facts.current_stage_id !== null) list.push(facts.current_stage_id);
      if (facts.current_stage_name) list.push(facts.current_stage_name);
      return { list };
    }
    default:
      if (field.startsWith('custom_field.')) {
        const key = field.slice('custom_field.'.length);
        const hit = Object.entries(facts.custom_fields ?? {}).find(([k]) => norm(k) === norm(key));
        return { value: hit ? hit[1] : null };
      }
      return null;
  }
}

function compareNumbers(actual: unknown, expected: unknown, op: 'gt' | 'gte' | 'lt' | 'lte'): boolean {
  const a = toNumber(actual);
  const b = toNumber(expected);
  if (a === null || b === null) return false;
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  return a <= b;
}

export function evaluateLeaf(leaf: ConditionLeaf, facts: ContactFacts): boolean {
  const read = readField(String(leaf.field ?? ''), facts);
  if (!read) return false; // unknown field never matches
  const op = String(leaf.operator ?? '') as ConditionOperator;
  const expected = leaf.value;

  // reply_text_contains reads as "contains" whatever operator was saved, unless it says not_contains.
  if (leaf.field === 'reply_text_contains') {
    const text = norm((read as { value: unknown }).value);
    const words = toList(expected).map(norm).filter(Boolean);
    if (words.length === 0) return op === 'exists' ? text.length > 0 : false;
    const has = words.some((w) => text.includes(w));
    return op === 'not_contains' || op === 'not_equals' ? !has : has;
  }

  if ('list' in read) {
    const list = read.list;
    const member = (v: unknown) => list.some((x) => sameValue(x, v));
    switch (op) {
      case 'equals':
      case 'contains': return member(expected);
      case 'not_equals':
      case 'not_contains': return !member(expected);
      case 'in': return toList(expected).some(member);
      case 'exists': return expected === false ? list.length === 0 : list.length > 0;
      default: return false; // gt/lt make no sense on lists
    }
  }

  const actual = read.value;
  switch (op) {
    case 'equals': return !isEmpty(actual) && sameValue(actual, expected);
    case 'not_equals': return isEmpty(actual) || !sameValue(actual, expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': return compareNumbers(actual, expected, op);
    case 'contains': return !isEmpty(actual) && norm(actual).includes(norm(expected));
    case 'not_contains': return isEmpty(actual) || !norm(actual).includes(norm(expected));
    case 'in': return !isEmpty(actual) && toList(expected).some((v) => sameValue(actual, v));
    case 'exists': return expected === false ? isEmpty(actual) : !isEmpty(actual);
    default: return false; // unknown operator never matches
  }
}

/** Max nesting depth, so a broken saved rule can never recurse forever. */
const MAX_DEPTH = 10;

export function evaluateConditions(group: ConditionGroup | null | undefined, facts: ContactFacts, depth = 0): boolean {
  if (!group || !Array.isArray(group.items) || group.items.length === 0) return true;
  if (depth > MAX_DEPTH) return false;
  const isOr = String(group.op ?? 'AND').toUpperCase() === 'OR';
  const results = group.items.map((item) =>
    isGroup(item) ? evaluateConditions(item, facts, depth + 1) : evaluateLeaf(item as ConditionLeaf, facts)
  );
  return isOr ? results.some(Boolean) : results.every(Boolean);
}

/** True when the conditions mention any day-based field (these rules need the time_tick worker). */
export function usesTimeFields(group: ConditionGroup | null | undefined, depth = 0): boolean {
  if (!group || !Array.isArray(group.items) || depth > MAX_DEPTH) return false;
  return group.items.some((item) =>
    isGroup(item)
      ? usesTimeFields(item, depth + 1)
      : (TIME_FIELDS as readonly string[]).includes(String((item as ConditionLeaf).field))
  );
}
