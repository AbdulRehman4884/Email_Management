/**
 * CRM step 5: tags on campaigns and leads, and the per-campaign CRM options
 * (start pipeline + tags added to every lead of the campaign).
 *
 * Pure helpers (validateTagInput, cleanIdList) are unit tested in __tests__/tags.test.ts.
 */
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';
import { REPLY_LABELS } from '../../constants/replyLabels.js';

type Db = Pick<PoolClient, 'query'>;

export const TAG_SCOPES = ['both', 'contact', 'campaign'] as const;
export type TagScope = (typeof TAG_SCOPES)[number];

/** Colors offered in the tag editor. Any #rrggbb is accepted. */
export const TAG_COLORS = ['#6366f1', '#22c55e', '#ef4444', '#eab308', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#6b7280'];

export const MAX_TAGS_PER_USER = 200;
export const MAX_BULK_CONTACTS = 1000;

export interface CleanTag {
  name: string;
  color: string;
  scope: TagScope;
}

/** Checks a tag from the API. `partial` = PATCH (only the fields sent). */
export function validateTagInput(
  body: Record<string, unknown>,
  partial = false
): { ok: true; value: Partial<CleanTag> } | { ok: false; error: string } {
  const out: Partial<CleanTag> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('name')) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) return { ok: false, error: 'Tag name is required' };
    if (name.length > 50) return { ok: false, error: 'Tag name: at most 50 characters' };
    out.name = name;
  }
  if (!partial || has('color')) {
    const color = body.color == null || body.color === '' ? TAG_COLORS[0]! : String(body.color).trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) return { ok: false, error: 'Color must look like #22c55e' };
    out.color = color;
  }
  if (!partial || has('scope')) {
    const scope = body.scope == null || body.scope === '' ? 'both' : String(body.scope);
    if (!(TAG_SCOPES as readonly string[]).includes(scope)) return { ok: false, error: 'Scope must be both, contact or campaign' };
    out.scope = scope as TagScope;
  }
  return { ok: true, value: out };
}

/** Positive whole numbers, no duplicates, at most `max`. Returns null when the input is not a list. */
export function cleanIdList(raw: unknown, max = MAX_BULK_CONTACTS): number[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out = new Set<number>();
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) return null;
    out.add(n);
    if (out.size > max) return null;
  }
  return [...out];
}

/** Keeps only the tag ids that belong to the user. */
export async function ownTagIds(db: Db, userId: number, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const r = await db.query<{ id: number }>(`SELECT id FROM crm_tags WHERE user_id = $1 AND id = ANY($2::int[])`, [userId, ids]);
  return r.rows.map((x) => x.id);
}

export interface CampaignCrmSettings {
  pipelineId: number | null;
  autoTagIds: number[];
}

export async function getCampaignSettings(db: Db, campaignId: number): Promise<CampaignCrmSettings> {
  const r = await db.query<{ pipeline_id: number | null; auto_tag_ids: number[] | null }>(
    `SELECT pipeline_id, auto_tag_ids FROM crm_campaign_settings WHERE campaign_id = $1`,
    [campaignId]
  );
  return { pipelineId: r.rows[0]?.pipeline_id ?? null, autoTagIds: (r.rows[0]?.auto_tag_ids ?? []).map(Number) };
}

/**
 * Adds the campaign's auto tags to one lead (when the lead is linked to the campaign).
 * Tags that were deleted, or belong to someone else, are skipped.
 */
export async function applyAutoTagsToContact(db: Db, campaignId: number, contactId: number): Promise<number> {
  const r = await db.query(
    `INSERT INTO crm_contact_tags (contact_id, tag_id)
     SELECT $2, t.id
       FROM crm_campaign_settings s
       JOIN crm_tags t ON t.id = ANY(s.auto_tag_ids) AND t.user_id = s.user_id
      WHERE s.campaign_id = $1
     ON CONFLICT DO NOTHING`,
    [campaignId, contactId]
  );
  return r.rowCount ?? 0;
}

/** Adds the campaign's auto tags to every lead already linked to the campaign. Returns rows added. */
export async function applyAutoTagsToCampaign(db: Db, campaignId: number): Promise<number> {
  const r = await db.query(
    `INSERT INTO crm_contact_tags (contact_id, tag_id)
     SELECT DISTINCT x.contact_id, t.id
       FROM crm_campaign_settings s
       JOIN crm_tags t ON t.id = ANY(s.auto_tag_ids) AND t.user_id = s.user_id
       JOIN crm_contact_recipients x ON x.campaign_id = s.campaign_id
      WHERE s.campaign_id = $1
     ON CONFLICT DO NOTHING`,
    [campaignId]
  );
  return r.rowCount ?? 0;
}

/**
 * Latest labeled inbound reply per recipient of one campaign. Used for the campaign's label bar and
 * for "leads of campaign X with label Y", so both always show the same numbers.
 * Gives rows (recipient_id, label).
 */
export function campaignLatestLabelsSql(campaignParam: string): string {
  return `SELECT DISTINCT ON (er.recipient_id) er.recipient_id, er.label
            FROM email_replies er
           WHERE er.campaign_id = ${campaignParam}
             AND er.direction = 'inbound'
             AND er.label IS NOT NULL
           ORDER BY er.recipient_id, er.received_at DESC, er.id DESC`;
}

/** Leads per reply label for one campaign: { interested: 3, ... } with every label present. */
export async function campaignLabelBreakdown(campaignId: number, db: Db = dbPool): Promise<Record<string, number>> {
  const r = await db.query<{ label: string; n: number }>(
    `SELECT l.label, count(*)::int AS n FROM (${campaignLatestLabelsSql('$1')}) l GROUP BY l.label`,
    [campaignId]
  );
  const out: Record<string, number> = Object.fromEntries(REPLY_LABELS.map((l) => [l, 0]));
  for (const row of r.rows) out[row.label] = row.n;
  return out;
}

/**
 * Turns off rules that use a tag that is being deleted (add_tag / remove_tag action, or a has_tag
 * condition with this id or name). Rules are not deleted, so the user can fix them.
 */
export async function deactivateRulesUsingTag(db: Db, userId: number, tag: { id: number; name: string }): Promise<number> {
  const rules = await db.query<{ id: number; conditions: unknown; actions: unknown }>(
    `SELECT id, conditions, actions FROM crm_rules WHERE user_id = $1 AND is_active`,
    [userId]
  );
  const name = tag.name.toLowerCase();
  const usesTag = (cond: unknown): boolean => {
    if (!cond || typeof cond !== 'object') return false;
    const c = cond as { items?: unknown[]; field?: unknown; value?: unknown };
    if (Array.isArray(c.items)) return c.items.some(usesTag);
    if (c.field !== 'has_tag') return false;
    const values = Array.isArray(c.value) ? c.value : [c.value];
    return values.some((v) => Number(v) === tag.id || String(v ?? '').toLowerCase() === name);
  };
  const ids = rules.rows
    .filter((r) => {
      const actions = Array.isArray(r.actions) ? (r.actions as Array<Record<string, unknown>>) : [];
      return actions.some((a) => (a.type === 'add_tag' || a.type === 'remove_tag') && Number(a.tagId) === tag.id) || usesTag(r.conditions);
    })
    .map((r) => r.id);
  if (ids.length === 0) return 0;
  await db.query(`UPDATE crm_rules SET is_active = false, updated_at = now() WHERE id = ANY($1::int[])`, [ids]);
  return ids.length;
}
