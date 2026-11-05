/**
 * Default CRM pipeline + default rules (step 3).
 *
 * - ensureDefaultPipeline(): gives a user the 8-stage "Sales Pipeline" if they have none
 *   (same stages as scripts/crmBackfill.ts), so users who sign up later also get a CRM.
 * - seedDefaultRules(): adds the starter rules to a pipeline once (crm_pipelines.rules_seeded_at).
 *   Rules a user deletes later are never added back.
 */
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';

type Db = Pick<PoolClient, 'query'>;

export const DEFAULT_STAGES: Array<{ name: string; color: string; type: 'normal' | 'won' | 'lost'; stopFollowUps: boolean }> = [
  { name: 'New Lead', color: '#94a3b8', type: 'normal', stopFollowUps: false },
  { name: 'Contacted', color: '#38bdf8', type: 'normal', stopFollowUps: false },
  { name: 'Engaged', color: '#818cf8', type: 'normal', stopFollowUps: false },
  { name: 'Replied', color: '#a855f7', type: 'normal', stopFollowUps: false },
  { name: 'Interested', color: '#22c55e', type: 'normal', stopFollowUps: true },
  { name: 'Meeting Booked', color: '#f59e0b', type: 'normal', stopFollowUps: true },
  { name: 'Won', color: '#16a34a', type: 'won', stopFollowUps: true },
  { name: 'Lost', color: '#ef4444', type: 'lost', stopFollowUps: true },
];

/** Returns the user's default (or first) pipeline id, creating the default one if they have none. */
export async function ensureDefaultPipeline(userId: number, db: Db = dbPool): Promise<number> {
  const existing = await db.query<{ id: number }>(
    `SELECT id FROM crm_pipelines WHERE user_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  await db.query(`INSERT INTO crm_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const created = await db.query<{ id: number }>(
    `INSERT INTO crm_pipelines (user_id, name, is_default) VALUES ($1, 'Sales Pipeline', true) RETURNING id`,
    [userId]
  );
  const pipelineId = created.rows[0]!.id;
  for (const [position, st] of DEFAULT_STAGES.entries()) {
    await db.query(
      `INSERT INTO crm_pipeline_stages (pipeline_id, user_id, name, color, position, type, stop_follow_ups)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pipeline_id, name) DO NOTHING`,
      [pipelineId, userId, st.name, st.color, position, st.type, st.stopFollowUps]
    );
  }
  return pipelineId;
}

export interface RuleSeed {
  name: string;
  trigger: string;
  conditions: { op: 'AND' | 'OR'; items: Array<{ field: string; operator: string; value?: unknown }> };
  /** Stage name to move to (looked up in the pipeline); omitted = no move. */
  moveTo?: string;
  extraActions?: Array<Record<string, unknown>>;
  priority?: number;
}

/** The starter rules from the CRM prompt. Stage names must match DEFAULT_STAGES. */
export const DEFAULT_RULES: RuleSeed[] = [
  { name: 'Email sent → Contacted', trigger: 'email_sent', conditions: { op: 'AND', items: [] }, moveTo: 'Contacted' },
  {
    name: 'Opened 2+ times → Engaged',
    trigger: 'email_opened',
    conditions: { op: 'AND', items: [{ field: 'open_count', operator: 'gte', value: 2 }] },
    moveTo: 'Engaged',
  },
  {
    name: 'Real reply → Replied',
    trigger: 'reply_received',
    conditions: {
      op: 'AND',
      items: [
        { field: 'reply_label', operator: 'not_equals', value: 'out_of_office' },
        { field: 'reply_label', operator: 'not_equals', value: 'bounce_unsubscribe' },
      ],
    },
    moveTo: 'Replied',
  },
  {
    name: 'Interested → Interested + stop follow-ups + notify',
    trigger: 'reply_labeled',
    conditions: { op: 'AND', items: [{ field: 'reply_label', operator: 'equals', value: 'interested' }] },
    moveTo: 'Interested',
    extraActions: [
      { type: 'stop_follow_ups' },
      { type: 'notify_user', message: '{{name}} ({{email}}) is interested. Reply soon!' },
    ],
  },
  {
    name: 'Meeting booked → Meeting Booked',
    trigger: 'reply_labeled',
    conditions: { op: 'AND', items: [{ field: 'reply_label', operator: 'equals', value: 'meeting_booked' }] },
    moveTo: 'Meeting Booked',
  },
  {
    name: 'Not interested / unsubscribe reply → Lost',
    trigger: 'reply_labeled',
    conditions: { op: 'AND', items: [{ field: 'reply_label', operator: 'in', value: ['not_interested', 'bounce_unsubscribe'] }] },
    moveTo: 'Lost',
    extraActions: [{ type: 'stop_follow_ups' }],
  },
  {
    name: 'Bounced → Lost',
    trigger: 'bounced',
    conditions: { op: 'AND', items: [] },
    moveTo: 'Lost',
    extraActions: [{ type: 'stop_follow_ups' }],
  },
  {
    name: 'Unsubscribed → Lost',
    trigger: 'unsubscribed',
    conditions: { op: 'AND', items: [] },
    moveTo: 'Lost',
    extraActions: [{ type: 'stop_follow_ups' }],
  },
  {
    name: 'Out of office → follow up in 7 days',
    trigger: 'reply_labeled',
    conditions: { op: 'AND', items: [{ field: 'reply_label', operator: 'equals', value: 'out_of_office' }] },
    extraActions: [{ type: 'schedule_follow_up', templateId: null, afterDays: 7 }],
  },
  {
    name: '3 follow-ups, no reply, 5 days → Lost',
    trigger: 'time_tick',
    conditions: {
      op: 'AND',
      items: [
        { field: 'follow_up_count', operator: 'gte', value: 3 },
        { field: 'reply_count', operator: 'equals', value: 0 },
        { field: 'days_since_last_outbound', operator: 'gte', value: 5 },
      ],
    },
    moveTo: 'Lost',
  },
];

// ─── Pipeline templates (step 4: "Templates" button in the Pipeline Builder) ───────────────

export type StageSeed = { name: string; color: string; type: 'normal' | 'won' | 'lost'; stopFollowUps: boolean; manualOnly?: boolean };

const notAutoReply = {
  op: 'AND' as const,
  items: [
    { field: 'reply_label', operator: 'not_equals', value: 'out_of_office' },
    { field: 'reply_label', operator: 'not_equals', value: 'bounce_unsubscribe' },
  ],
};
const labelIs = (value: string | string[]) => ({
  op: 'AND' as const,
  items: [{ field: 'reply_label', operator: Array.isArray(value) ? 'in' : 'equals', value }],
});
const always = { op: 'AND' as const, items: [] };

export const PIPELINE_TEMPLATES: Record<string, { label: string; description: string; stages: StageSeed[]; rules: RuleSeed[] }> = {
  sales: {
    label: 'Sales Outreach',
    description: 'The default: New Lead > Contacted > Engaged > Replied > Interested > Meeting Booked > Won / Lost, with 9 rules.',
    stages: DEFAULT_STAGES,
    rules: DEFAULT_RULES,
  },
  simple: {
    label: 'Simple',
    description: 'Contacted > Replied > Won / Lost. Good for small lists.',
    stages: [
      { name: 'Contacted', color: '#38bdf8', type: 'normal', stopFollowUps: false },
      { name: 'Replied', color: '#a855f7', type: 'normal', stopFollowUps: true },
      { name: 'Won', color: '#16a34a', type: 'won', stopFollowUps: true },
      { name: 'Lost', color: '#ef4444', type: 'lost', stopFollowUps: true },
    ],
    rules: [
      { name: 'Email sent → Contacted', trigger: 'email_sent', conditions: always, moveTo: 'Contacted' },
      { name: 'Real reply → Replied', trigger: 'reply_received', conditions: notAutoReply, moveTo: 'Replied' },
      {
        name: 'Interested → notify',
        trigger: 'reply_labeled',
        conditions: labelIs('interested'),
        extraActions: [{ type: 'notify_user', message: '{{name}} ({{email}}) is interested. Reply soon!' }],
      },
      { name: 'Not interested → Lost', trigger: 'reply_labeled', conditions: labelIs(['not_interested', 'bounce_unsubscribe']), moveTo: 'Lost' },
      { name: 'Bounced → Lost', trigger: 'bounced', conditions: always, moveTo: 'Lost', extraActions: [{ type: 'stop_follow_ups' }] },
      { name: 'Unsubscribed → Lost', trigger: 'unsubscribed', conditions: always, moveTo: 'Lost' },
    ],
  },
  recruiting: {
    label: 'Recruiting',
    description: 'Sourced > Contacted > Replied > Interested > Interview > Offer > Hired / Rejected.',
    stages: [
      { name: 'Sourced', color: '#94a3b8', type: 'normal', stopFollowUps: false },
      { name: 'Contacted', color: '#38bdf8', type: 'normal', stopFollowUps: false },
      { name: 'Replied', color: '#a855f7', type: 'normal', stopFollowUps: false },
      { name: 'Interested', color: '#22c55e', type: 'normal', stopFollowUps: true },
      { name: 'Interview', color: '#f59e0b', type: 'normal', stopFollowUps: true },
      { name: 'Offer', color: '#0ea5e9', type: 'normal', stopFollowUps: true, manualOnly: true },
      { name: 'Hired', color: '#16a34a', type: 'won', stopFollowUps: true },
      { name: 'Rejected', color: '#ef4444', type: 'lost', stopFollowUps: true },
    ],
    rules: [
      { name: 'Email sent → Contacted', trigger: 'email_sent', conditions: always, moveTo: 'Contacted' },
      { name: 'Real reply → Replied', trigger: 'reply_received', conditions: notAutoReply, moveTo: 'Replied' },
      {
        name: 'Interested → Interested + notify',
        trigger: 'reply_labeled',
        conditions: labelIs('interested'),
        moveTo: 'Interested',
        extraActions: [{ type: 'notify_user', message: '{{name}} is interested in the role.' }],
      },
      { name: 'Call booked → Interview', trigger: 'reply_labeled', conditions: labelIs('meeting_booked'), moveTo: 'Interview' },
      { name: 'Not interested → Rejected', trigger: 'reply_labeled', conditions: labelIs(['not_interested', 'bounce_unsubscribe']), moveTo: 'Rejected' },
      { name: 'Bounced → Rejected', trigger: 'bounced', conditions: always, moveTo: 'Rejected', extraActions: [{ type: 'stop_follow_ups' }] },
      { name: 'Unsubscribed → Rejected', trigger: 'unsubscribed', conditions: always, moveTo: 'Rejected' },
      {
        name: 'Out of office → follow up in 7 days',
        trigger: 'reply_labeled',
        conditions: labelIs('out_of_office'),
        extraActions: [{ type: 'schedule_follow_up', templateId: null, afterDays: 7 }],
      },
    ],
  },
};

/** Inserts rules, resolving moveTo stage names inside the pipeline. Skips rules whose stage is missing. */
export async function insertRuleSeeds(pipelineId: number, userId: number, seeds: RuleSeed[], db: Db = dbPool): Promise<number> {
  const stages = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM crm_pipeline_stages WHERE pipeline_id = $1`,
    [pipelineId]
  );
  const byName = new Map(stages.rows.map((s) => [s.name.trim().toLowerCase(), s.id]));
  let added = 0;
  for (const [i, r] of seeds.entries()) {
    const actions: Array<Record<string, unknown>> = [];
    if (r.moveTo) {
      const stageId = byName.get(r.moveTo.toLowerCase());
      if (stageId == null) continue;
      actions.push({ type: 'move_to_stage', stageId });
    }
    actions.push(...(r.extraActions ?? []));
    await db.query(
      `INSERT INTO crm_rules (user_id, pipeline_id, from_stage_id, name, priority, is_active, trigger, conditions, actions, forward_only)
       VALUES ($1, $2, NULL, $3, $4, true, $5, $6::jsonb, $7::jsonb, true)`,
      [userId, pipelineId, r.name, r.priority ?? 100 - i, r.trigger, JSON.stringify(r.conditions), JSON.stringify(actions)]
    );
    added++;
  }
  return added;
}

/** Creates a pipeline with the template's stages and rules (rules_seeded_at set, so defaults are not added again). */
export async function createPipelineFromTemplate(
  userId: number,
  name: string,
  templateKey: string,
  db: Db,
  makeDefault = false
): Promise<number> {
  const tpl = PIPELINE_TEMPLATES[templateKey];
  if (makeDefault) await db.query(`UPDATE crm_pipelines SET is_default = false WHERE user_id = $1`, [userId]);
  const created = await db.query<{ id: number }>(
    `INSERT INTO crm_pipelines (user_id, name, is_default, rules_seeded_at) VALUES ($1, $2, $3, now()) RETURNING id`,
    [userId, name, makeDefault]
  );
  const pipelineId = created.rows[0]!.id;
  for (const [position, st] of (tpl?.stages ?? []).entries()) {
    await db.query(
      `INSERT INTO crm_pipeline_stages (pipeline_id, user_id, name, color, position, type, stop_follow_ups, manual_only)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [pipelineId, userId, st.name, st.color, position, st.type, st.stopFollowUps, st.manualOnly ?? false]
    );
  }
  if (tpl) await insertRuleSeeds(pipelineId, userId, tpl.rules, db);
  return pipelineId;
}

/**
 * Adds DEFAULT_RULES to the pipeline once. Skips a rule when its stage does not exist
 * (e.g. the user renamed it). Locks the pipeline row so two processes never seed twice.
 */
export async function seedDefaultRules(pipelineId: number, db: Db = dbPool): Promise<number> {
  const pipe = await db.query<{ user_id: number; rules_seeded_at: string | null }>(
    `SELECT user_id, rules_seeded_at FROM crm_pipelines WHERE id = $1 FOR UPDATE`,
    [pipelineId]
  );
  const row = pipe.rows[0];
  if (!row || row.rules_seeded_at) return 0;
  const added = await insertRuleSeeds(pipelineId, row.user_id, DEFAULT_RULES, db);
  await db.query(`UPDATE crm_pipelines SET rules_seeded_at = now() WHERE id = $1`, [pipelineId]);
  return added;
}

/** Seeds every pipeline that never got its default rules. Each pipeline in its own transaction. */
export async function seedDefaultRulesForAllPipelines(): Promise<number> {
  const pending = await dbPool.query<{ id: number }>(`SELECT id FROM crm_pipelines WHERE rules_seeded_at IS NULL ORDER BY id`);
  let total = 0;
  for (const { id } of pending.rows) {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      total += await seedDefaultRules(id, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`[crm] seeding default rules for pipeline ${id} failed:`, err);
    } finally {
      client.release();
    }
  }
  return total;
}
