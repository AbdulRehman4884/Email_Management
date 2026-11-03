/**
 * Lead filters shared by the leads list, the CSV export and the dashboard summary (CRM steps 5 and 8).
 *
 *   pipelineId, stageId, campaignId           numbers
 *   label        one or more reply labels, comma separated; 'none' = no reply yet.
 *                With campaignId: the latest labeled reply to that campaign (same numbers as the campaign label bar).
 *   tagIds       comma separated; the lead must have all of them
 *   scoreTier    hot / warm / cold, comma separated
 *   needsReply   1 = only leads waiting for your reply (not snoozed)
 *   hotOnly      1 = Interested or hot score, not in a Won/Lost stage
 *   from, to     YYYY-MM-DD: when the lead was added to the CRM (inclusive)
 *   search       name, email or company
 *
 * parseContactFilters() is pure and unit tested.
 */
import { REPLY_LABELS } from '../../constants/replyLabels.js';
import { campaignLatestLabelsSql, cleanIdList } from './tags.js';

export class FilterError extends Error {}

export interface ContactFilters {
  pipelineId: number | null;
  stageId: number | null;
  campaignId: number | null;
  labels: string[];
  tagIds: number[];
  scoreTiers: string[];
  needsReply: boolean;
  hotOnly: boolean;
  from: string | null;
  to: string | null;
  search: string;
}

export const SCORE_TIERS = ['hot', 'warm', 'cold'] as const;
export const CONTACT_SORTS = ['recent', 'score', 'name', 'hot', 'waiting', 'added'] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];

function optId(v: unknown, name: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new FilterError(`Invalid ${name}`);
  return n;
}

function list(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  const raw = Array.isArray(v) ? v.join(',') : String(v);
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

function day(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) throw new FilterError(`${name} must be a date like 2026-01-31`);
  return s;
}

const yes = (v: unknown) => v === '1' || v === 'true' || v === true;

/** Query string -> checked filters. Throws FilterError with a plain-English message. */
export function parseContactFilters(q: Record<string, unknown>): ContactFilters {
  const labels = list(q.label ?? q.labels);
  for (const l of labels) {
    if (l !== 'none' && !(REPLY_LABELS as readonly string[]).includes(l)) throw new FilterError(`Unknown label "${l}"`);
  }
  const tagIds = cleanIdList(list(q.tagIds ?? q.tagId), 20);
  if (tagIds === null) throw new FilterError('Invalid tagIds');
  const scoreTiers = list(q.scoreTier ?? q.scoreTiers);
  for (const t of scoreTiers) if (!(SCORE_TIERS as readonly string[]).includes(t)) throw new FilterError(`Unknown score tier "${t}"`);
  const from = day(q.from, 'from');
  const to = day(q.to, 'to');
  if (from && to && from > to) throw new FilterError('"from" must be before "to"');
  return {
    pipelineId: optId(q.pipelineId, 'pipelineId'),
    stageId: optId(q.stageId, 'stageId'),
    campaignId: optId(q.campaignId, 'campaignId'),
    labels,
    tagIds,
    scoreTiers,
    needsReply: yes(q.needsReply),
    hotOnly: yes(q.hotOnly),
    from,
    to,
    search: String(q.search ?? '').trim().slice(0, 100),
  };
}

/**
 * WHERE clause for crm_contacts (alias cc) of one user. `params` starts with the user id ($1).
 * `skip` leaves out filters a caller handles itself (e.g. the board ignores stageId per column).
 */
export function contactWhereSql(
  userId: number,
  f: ContactFilters,
  skip: Partial<Record<keyof ContactFilters, boolean>> = {}
): { where: string; params: unknown[] } {
  const params: unknown[] = [userId];
  const where: string[] = ['cc.user_id = $1'];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (f.pipelineId != null && !skip.pipelineId) where.push(`cc.pipeline_id = ${p(f.pipelineId)}`);
  if (f.stageId != null && !skip.stageId) where.push(`cc.stage_id = ${p(f.stageId)}`);
  if (f.tagIds.length && !skip.tagIds) {
    where.push(`(SELECT count(*) FROM crm_contact_tags ct WHERE ct.contact_id = cc.id AND ct.tag_id = ANY(${p(f.tagIds)}::int[])) = ${f.tagIds.length}`);
  }

  const realLabels = f.labels.filter((l) => l !== 'none');
  const wantNone = f.labels.includes('none');
  if (f.campaignId != null && !skip.campaignId) {
    const cp = p(f.campaignId);
    where.push(`EXISTS (SELECT 1 FROM crm_contact_recipients x WHERE x.contact_id = cc.id AND x.campaign_id = ${cp})`);
    if (f.labels.length && !skip.labels) {
      const parts: string[] = [];
      if (realLabels.length) {
        parts.push(`EXISTS (SELECT 1 FROM (${campaignLatestLabelsSql(cp)}) l JOIN crm_contact_recipients x ON x.recipient_id = l.recipient_id
                    WHERE x.contact_id = cc.id AND l.label = ANY(${p(realLabels)}::text[]))`);
      }
      if (wantNone) parts.push('cc.last_reply_label IS NULL');
      where.push(`(${parts.join(' OR ')})`);
    }
  } else if (f.labels.length && !skip.labels) {
    const parts: string[] = [];
    if (realLabels.length) parts.push(`cc.last_reply_label = ANY(${p(realLabels)}::text[])`);
    if (wantNone) parts.push('cc.last_reply_label IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }

  if (f.scoreTiers.length && !skip.scoreTiers) where.push(`cc.score_tier = ANY(${p(f.scoreTiers)}::text[])`);
  if (f.needsReply && !skip.needsReply) where.push(`cc.needs_reply AND (cc.snoozed_until IS NULL OR cc.snoozed_until <= now())`);
  // E2E-05: Hot leads = people to talk to now, so leads already in a Won or Lost stage are left out.
  if (f.hotOnly && !skip.hotOnly) {
    where.push(`(cc.last_reply_label = 'interested' OR cc.score_tier = 'hot')`);
    where.push(`NOT EXISTS (SELECT 1 FROM crm_pipeline_stages hs WHERE hs.id = cc.stage_id AND hs.type IN ('won', 'lost'))`);
  }
  if (f.from && !skip.from) where.push(`cc.created_at >= ${p(f.from)}::date`);
  if (f.to && !skip.to) where.push(`cc.created_at < (${p(f.to)}::date + 1)`);
  if (f.search && !skip.search) {
    const sp = p(`%${f.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(cc.email ILIKE ${sp} OR cc.name ILIKE ${sp} OR cc.company ILIKE ${sp})`);
  }
  return { where: where.join(' AND '), params };
}

export function contactOrderSql(sort: unknown): string {
  switch (String(sort ?? 'recent')) {
    case 'score':
      return 'cc.score DESC, cc.id DESC';
    case 'name':
      return "lower(COALESCE(NULLIF(cc.name, ''), cc.email)) ASC, cc.id ASC";
    case 'hot':
      // Hot Leads panel: Interested + hot first, newest reply first.
      // COALESCE: a NULL label would sort first with DESC.
      return "COALESCE(cc.last_reply_label = 'interested', false) DESC, (cc.score_tier = 'hot') DESC, cc.last_inbound_at DESC NULLS LAST, cc.score DESC, cc.id DESC";
    case 'waiting':
      return 'cc.needs_reply DESC, cc.needs_reply_since ASC NULLS LAST, cc.id ASC';
    case 'added':
      return 'cc.created_at DESC, cc.id DESC';
    default:
      return 'GREATEST(cc.updated_at, COALESCE(cc.last_inbound_at, cc.updated_at)) DESC, cc.id DESC';
  }
}
