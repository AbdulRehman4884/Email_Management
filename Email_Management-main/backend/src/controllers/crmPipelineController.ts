/**
 * CRM step 4: Pipeline Builder APIs. Mounted at /api/crm (auth + crmEnabled plan check in index.ts).
 * Every query is scoped to the logged-in user: an id from another user always answers 404.
 */
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { dbPool } from '../lib/db.js';
import { PIPELINE_TEMPLATES, createPipelineFromTemplate } from '../lib/crm/pipelines.js';
import { validateRuleInput, RULE_TRIGGERS, type CleanRule, type RuleContext } from '../lib/crm/ruleValidation.js';
import { dryRunRules } from '../lib/crm/ruleEngine.js';
import { isReplyLabel } from '../constants/replyLabels.js';

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function userIdOf(req: Request): number {
  const id = req.user?.id;
  if (!id) throw new HttpError(401, 'Unauthorized');
  return id;
}

function idParam(req: Request, name: string): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, ...err.extra });
        return;
      }
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === '23505') {
        res.status(409).json({ error: 'A stage with this name already exists in the pipeline' });
        return;
      }
      console.error('[crm pipelines]', err);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function ownPipeline(db: Pick<PoolClient, 'query'>, userId: number, pipelineId: number) {
  const r = await db.query<{ id: number; name: string; is_default: boolean }>(
    `SELECT id, name, is_default FROM crm_pipelines WHERE id = $1 AND user_id = $2`,
    [pipelineId, userId]
  );
  if (!r.rows[0]) throw new HttpError(404, 'Pipeline not found');
  return r.rows[0];
}

// ─── shapes ─────────────────────────────────────────────────────────────────

type StageRow = {
  id: number; pipeline_id: number; name: string; color: string; position: number; type: string;
  manual_only: boolean; stop_follow_ups: boolean; contact_count?: number;
};
const stageOut = (s: StageRow) => ({
  id: s.id,
  pipelineId: s.pipeline_id,
  name: s.name,
  color: s.color,
  position: s.position,
  type: s.type,
  manualOnly: s.manual_only,
  stopFollowUps: s.stop_follow_ups,
  contactCount: s.contact_count ?? 0,
});

type RuleRowDb = {
  id: number; pipeline_id: number; from_stage_id: number | null; name: string; priority: number; is_active: boolean;
  trigger: string; conditions: CleanRule['conditions']; actions: CleanRule['actions']; forward_only: boolean;
  created_at: string; updated_at: string;
};
const ruleOut = (r: RuleRowDb) => ({
  id: r.id,
  pipelineId: r.pipeline_id,
  fromStageId: r.from_stage_id,
  name: r.name,
  priority: r.priority,
  isActive: r.is_active,
  trigger: r.trigger,
  conditions: r.conditions,
  actions: r.actions,
  forwardOnly: r.forward_only,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const ruleFromDb = (r: RuleRowDb): CleanRule => ({
  name: r.name,
  trigger: r.trigger as CleanRule['trigger'],
  fromStageId: r.from_stage_id,
  priority: r.priority,
  isActive: r.is_active,
  forwardOnly: r.forward_only,
  conditions: r.conditions,
  actions: r.actions,
});

async function listStages(db: Pick<PoolClient, 'query'>, pipelineId: number) {
  const r = await db.query<StageRow>(
    `SELECT s.id, s.pipeline_id, s.name, s.color, s.position, s.type, s.manual_only, s.stop_follow_ups,
            (SELECT count(*)::int FROM crm_contacts cc WHERE cc.stage_id = s.id) AS contact_count
       FROM crm_pipeline_stages s WHERE s.pipeline_id = $1 ORDER BY s.position, s.id`,
    [pipelineId]
  );
  return r.rows.map(stageOut);
}

async function ruleContext(db: Pick<PoolClient, 'query'>, userId: number, pipelineId: number): Promise<RuleContext> {
  const stages = await db.query<{ id: number }>(`SELECT id FROM crm_pipeline_stages WHERE pipeline_id = $1`, [pipelineId]);
  const tags = await db.query<{ id: number }>(`SELECT id FROM crm_tags WHERE user_id = $1`, [userId]);
  return { stageIds: new Set(stages.rows.map((s) => s.id)), tagIds: new Set(tags.rows.map((t) => t.id)) };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const STAGE_TYPES = ['normal', 'won', 'lost'];

function cleanStageInput(body: Record<string, unknown>, partial: boolean) {
  const out: { name?: string; color?: string; type?: string; manualOnly?: boolean; stopFollowUps?: boolean } = {};
  const errors: string[] = [];
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) errors.push('name: required');
    else if (name.length > 100) errors.push('name: at most 100 characters');
    out.name = name;
  }
  if (!partial || body.color !== undefined) {
    const color = String(body.color ?? '#6366f1');
    if (!HEX.test(color)) errors.push('color: use a hex color like #22c55e');
    out.color = color;
  }
  if (!partial || body.type !== undefined) {
    const type = String(body.type ?? 'normal');
    if (!STAGE_TYPES.includes(type)) errors.push('type: normal, won or lost');
    out.type = type;
  }
  if (body.manualOnly !== undefined) out.manualOnly = body.manualOnly === true;
  if (body.stopFollowUps !== undefined) out.stopFollowUps = body.stopFollowUps === true;
  if (errors.length) throw new HttpError(400, errors.join('; '), { errors });
  return out;
}

async function assertStageNameFree(db: Pick<PoolClient, 'query'>, pipelineId: number, name: string, exceptId?: number) {
  const r = await db.query(
    `SELECT 1 FROM crm_pipeline_stages WHERE pipeline_id = $1 AND lower(name) = lower($2) AND id <> $3`,
    [pipelineId, name, exceptId ?? -1]
  );
  if (r.rowCount) throw new HttpError(409, `A stage named "${name}" already exists in this pipeline`);
}

// ─── pipelines ──────────────────────────────────────────────────────────────

export const listTemplates = handle(async (_req, res) => {
  res.json({
    templates: [
      ...Object.entries(PIPELINE_TEMPLATES).map(([key, t]) => ({
        key, label: t.label, description: t.description, stages: t.stages.map((s) => s.name), ruleCount: t.rules.length,
      })),
      { key: 'empty', label: 'Empty', description: 'No stages and no rules. Build it yourself.', stages: [], ruleCount: 0 },
    ],
  });
});

export const listPipelines = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query(
    `SELECT p.id, p.name, p.is_default, p.created_at,
            (SELECT count(*)::int FROM crm_pipeline_stages s WHERE s.pipeline_id = p.id) AS stage_count,
            (SELECT count(*)::int FROM crm_rules r WHERE r.pipeline_id = p.id) AS rule_count,
            (SELECT count(*)::int FROM crm_contacts c WHERE c.pipeline_id = p.id) AS contact_count
       FROM crm_pipelines p WHERE p.user_id = $1 ORDER BY p.is_default DESC, p.id`,
    [userId]
  );
  res.json({
    pipelines: r.rows.map((p) => ({
      id: p.id, name: p.name, isDefault: p.is_default, createdAt: p.created_at,
      stageCount: p.stage_count, ruleCount: p.rule_count, contactCount: p.contact_count,
    })),
  });
});

export const getPipeline = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  const p = await ownPipeline(dbPool, userId, pipelineId);
  const stages = await listStages(dbPool, pipelineId);
  const rules = await dbPool.query<RuleRowDb>(
    `SELECT * FROM crm_rules WHERE pipeline_id = $1 ORDER BY trigger, priority DESC, id`,
    [pipelineId]
  );
  res.json({ pipeline: { id: p.id, name: p.name, isDefault: p.is_default }, stages, rules: rules.rows.map(ruleOut) });
});

export const createPipeline = handle(async (req, res) => {
  const userId = userIdOf(req);
  const name = String(req.body?.name ?? '').trim();
  const template = String(req.body?.template ?? 'empty');
  if (!name || name.length > 255) throw new HttpError(400, 'name: 1 to 255 characters');
  if (template !== 'empty' && !PIPELINE_TEMPLATES[template]) throw new HttpError(400, 'template: sales, simple, recruiting or empty');
  const id = await inTransaction(async (client) => {
    const count = await client.query<{ c: number }>(`SELECT count(*)::int AS c FROM crm_pipelines WHERE user_id = $1`, [userId]);
    if ((count.rows[0]?.c ?? 0) >= 20) throw new HttpError(400, 'You can have at most 20 pipelines');
    const makeDefault = req.body?.makeDefault === true || (count.rows[0]?.c ?? 0) === 0;
    return createPipelineFromTemplate(userId, name, template, client, makeDefault);
  });
  res.status(201).json({ id });
});

export const updatePipeline = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  await inTransaction(async (client) => {
    await ownPipeline(client, userId, pipelineId);
    if (req.body?.name !== undefined) {
      const name = String(req.body.name ?? '').trim();
      if (!name || name.length > 255) throw new HttpError(400, 'name: 1 to 255 characters');
      await client.query(`UPDATE crm_pipelines SET name = $2 WHERE id = $1`, [pipelineId, name]);
    }
    if (req.body?.isDefault === true) {
      await client.query(`UPDATE crm_pipelines SET is_default = (id = $2) WHERE user_id = $1`, [userId, pipelineId]);
    }
  });
  res.json({ ok: true });
});

/** DELETE /pipelines/:id?moveToStageId=  (a stage in another pipeline, needed when the pipeline has leads) */
export const deletePipeline = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  const moveTo = req.query.moveToStageId ?? req.body?.moveToStageId;
  const result = await inTransaction(async (client) => {
    const p = await ownPipeline(client, userId, pipelineId);
    if (p.is_default) throw new HttpError(409, 'This is your default pipeline. Make another pipeline the default first.', { code: 'PIPELINE_IS_DEFAULT' });
    const cnt = await client.query<{ c: number }>(`SELECT count(*)::int AS c FROM crm_contacts WHERE pipeline_id = $1`, [pipelineId]);
    const contacts = cnt.rows[0]?.c ?? 0;
    let moved = 0;
    if (contacts > 0) {
      const target = Number(moveTo);
      if (!Number.isInteger(target)) {
        throw new HttpError(409, `This pipeline has ${contacts} lead(s). Pick a stage in another pipeline to move them to.`, {
          code: 'PIPELINE_HAS_CONTACTS', contacts,
        });
      }
      const t = await client.query<{ pipeline_id: number }>(
        `SELECT s.pipeline_id FROM crm_pipeline_stages s JOIN crm_pipelines p ON p.id = s.pipeline_id
          WHERE s.id = $1 AND p.user_id = $2 AND s.pipeline_id <> $3`,
        [target, userId, pipelineId]
      );
      if (!t.rows[0]) throw new HttpError(400, 'moveToStageId must be a stage in another of your pipelines');
      await client.query(
        `INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, changed_by_user_id, reason)
         SELECT id, NULL, $2, $3, 'pipeline deleted' FROM crm_contacts WHERE pipeline_id = $1`,
        [pipelineId, target, userId]
      );
      const m = await client.query(
        `UPDATE crm_contacts SET pipeline_id = $2, stage_id = $3, stage_entered_at = now(), updated_at = now() WHERE pipeline_id = $1`,
        [pipelineId, t.rows[0].pipeline_id, target]
      );
      moved = m.rowCount ?? 0;
    }
    await client.query(`DELETE FROM crm_pipelines WHERE id = $1`, [pipelineId]);
    return { moved };
  });
  res.json({ ok: true, ...result });
});

// ─── stages ─────────────────────────────────────────────────────────────────

export const getStages = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  await ownPipeline(dbPool, userId, pipelineId);
  res.json({ stages: await listStages(dbPool, pipelineId) });
});

export const createStage = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  const input = cleanStageInput(req.body ?? {}, false);
  const stage = await inTransaction(async (client) => {
    await ownPipeline(client, userId, pipelineId);
    const count = await client.query<{ c: number; next: number }>(
      `SELECT count(*)::int AS c, COALESCE(max(position) + 1, 0)::int AS next FROM crm_pipeline_stages WHERE pipeline_id = $1`,
      [pipelineId]
    );
    if ((count.rows[0]?.c ?? 0) >= 30) throw new HttpError(400, 'A pipeline can have at most 30 stages');
    await assertStageNameFree(client, pipelineId, input.name!);
    const stopFollowUps = input.stopFollowUps !== undefined ? input.stopFollowUps : (input.type === 'won' || input.type === 'lost');
    const r = await client.query<StageRow>(
      `INSERT INTO crm_pipeline_stages (pipeline_id, user_id, name, color, position, type, manual_only, stop_follow_ups)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [pipelineId, userId, input.name, input.color, count.rows[0]?.next ?? 0, input.type, input.manualOnly ?? false, stopFollowUps]
    );
    return r.rows[0]!;
  });
  res.status(201).json({ stage: stageOut(stage) });
});

export const updateStage = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  const stageId = idParam(req, 'stageId');
  const input = cleanStageInput(req.body ?? {}, true);
  const stage = await inTransaction(async (client) => {
    await ownPipeline(client, userId, pipelineId);
    const cur = await client.query<StageRow>(`SELECT * FROM crm_pipeline_stages WHERE id = $1 AND pipeline_id = $2`, [stageId, pipelineId]);
    if (!cur.rows[0]) throw new HttpError(404, 'Stage not found');
    if (input.name) await assertStageNameFree(client, pipelineId, input.name, stageId);
    const resolvedStopFollowUps = input.stopFollowUps !== undefined
      ? input.stopFollowUps
      : (input.type === 'won' || input.type === 'lost' ? true : null);
    const r = await client.query<StageRow>(
      `UPDATE crm_pipeline_stages
          SET name = COALESCE($3, name), color = COALESCE($4, color), type = COALESCE($5, type),
              manual_only = COALESCE($6, manual_only), stop_follow_ups = COALESCE($7, stop_follow_ups)
        WHERE id = $1 AND pipeline_id = $2 RETURNING *`,
      [stageId, pipelineId, input.name ?? null, input.color ?? null, input.type ?? null, input.manualOnly ?? null, resolvedStopFollowUps]
    );
    return r.rows[0]!;
  });
  res.json({ stage: stageOut(stage) });
});

/** PATCH /pipelines/:id/stages/reorder { stageIds: [all stage ids, in the new order] } */
export const reorderStages = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  const ids: number[] = Array.isArray(req.body?.stageIds) ? req.body.stageIds.map(Number) : [];
  await inTransaction(async (client) => {
    await ownPipeline(client, userId, pipelineId);
    const cur = await client.query<{ id: number }>(`SELECT id FROM crm_pipeline_stages WHERE pipeline_id = $1`, [pipelineId]);
    const have = new Set(cur.rows.map((r) => r.id));
    if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((id) => have.has(id))) {
      throw new HttpError(400, 'stageIds must list every stage of this pipeline exactly once');
    }
    for (const [i, id] of ids.entries()) {
      await client.query(`UPDATE crm_pipeline_stages SET position = $2 WHERE id = $1`, [id, i]);
    }
  });
  res.json({ stages: await listStages(dbPool, pipelineId) });
});

/**
 * DELETE /pipelines/:id/stages/:stageId?moveToStageId=
 * Leads in the stage must be moved to another stage of the same pipeline first.
 * Rules that start from or move to this stage are turned off (not deleted), so you can fix them.
 */
export const deleteStage = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  const stageId = idParam(req, 'stageId');
  const moveTo = req.query.moveToStageId ?? req.body?.moveToStageId;
  const result = await inTransaction(async (client) => {
    await ownPipeline(client, userId, pipelineId);
    const cur = await client.query(`SELECT 1 FROM crm_pipeline_stages WHERE id = $1 AND pipeline_id = $2`, [stageId, pipelineId]);
    if (!cur.rowCount) throw new HttpError(404, 'Stage not found');
    const cnt = await client.query<{ c: number }>(`SELECT count(*)::int AS c FROM crm_contacts WHERE stage_id = $1`, [stageId]);
    const contacts = cnt.rows[0]?.c ?? 0;
    let moved = 0;
    if (contacts > 0) {
      const target = Number(moveTo);
      if (!Number.isInteger(target) || target === stageId) {
        throw new HttpError(409, `${contacts} lead(s) are in this stage. Pick another stage to move them to.`, {
          code: 'STAGE_HAS_CONTACTS', contacts,
        });
      }
      const t = await client.query(`SELECT 1 FROM crm_pipeline_stages WHERE id = $1 AND pipeline_id = $2`, [target, pipelineId]);
      if (!t.rowCount) throw new HttpError(400, 'moveToStageId must be another stage of this pipeline');
      await client.query(
        `INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, changed_by_user_id, reason)
         SELECT id, $1, $2, $3, 'stage deleted' FROM crm_contacts WHERE stage_id = $1`,
        [stageId, target, userId]
      );
      const m = await client.query(
        `UPDATE crm_contacts SET stage_id = $2, stage_entered_at = now(), updated_at = now() WHERE stage_id = $1`,
        [stageId, target]
      );
      moved = m.rowCount ?? 0;
    }
    const off = await client.query(
      `UPDATE crm_rules
          SET is_active = false, updated_at = now(),
              from_stage_id = CASE WHEN from_stage_id = $2 THEN NULL ELSE from_stage_id END
        WHERE pipeline_id = $1
          AND (from_stage_id = $2 OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(actions) a
                 WHERE a->>'type' = 'move_to_stage' AND (a->>'stageId')::int = $2))`,
      [pipelineId, stageId]
    );
    await client.query(`DELETE FROM crm_pipeline_stages WHERE id = $1`, [stageId]);
    const left = await client.query<{ id: number }>(`SELECT id FROM crm_pipeline_stages WHERE pipeline_id = $1 ORDER BY position, id`, [pipelineId]);
    for (const [i, s] of left.rows.entries()) {
      await client.query(`UPDATE crm_pipeline_stages SET position = $2 WHERE id = $1`, [s.id, i]);
    }
    return { moved, rulesTurnedOff: off.rowCount ?? 0 };
  });
  res.json({ ok: true, ...result });
});

// ─── rules ──────────────────────────────────────────────────────────────────

export const getRules = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  await ownPipeline(dbPool, userId, pipelineId);
  const r = await dbPool.query<RuleRowDb>(`SELECT * FROM crm_rules WHERE pipeline_id = $1 ORDER BY trigger, priority DESC, id`, [pipelineId]);
  res.json({ rules: r.rows.map(ruleOut), triggers: RULE_TRIGGERS });
});

export const createRule = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  const rule = await inTransaction(async (client) => {
    await ownPipeline(client, userId, pipelineId);
    const count = await client.query<{ c: number }>(`SELECT count(*)::int AS c FROM crm_rules WHERE pipeline_id = $1`, [pipelineId]);
    if ((count.rows[0]?.c ?? 0) >= 100) throw new HttpError(400, 'A pipeline can have at most 100 rules');
    const v = validateRuleInput(req.body ?? {}, await ruleContext(client, userId, pipelineId));
    if (!v.ok) throw new HttpError(400, v.errors.join('; '), { errors: v.errors });
    const r = await client.query<RuleRowDb>(
      `INSERT INTO crm_rules (user_id, pipeline_id, from_stage_id, name, priority, is_active, trigger, conditions, actions, forward_only)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10) RETURNING *`,
      [userId, pipelineId, v.value.fromStageId, v.value.name, v.value.priority, v.value.isActive, v.value.trigger,
        JSON.stringify(v.value.conditions), JSON.stringify(v.value.actions), v.value.forwardOnly]
    );
    return r.rows[0]!;
  });
  res.status(201).json({ rule: ruleOut(rule) });
});

export const updateRule = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  const ruleId = idParam(req, 'ruleId');
  const rule = await inTransaction(async (client) => {
    await ownPipeline(client, userId, pipelineId);
    const cur = await client.query<RuleRowDb>(`SELECT * FROM crm_rules WHERE id = $1 AND pipeline_id = $2`, [ruleId, pipelineId]);
    if (!cur.rows[0]) throw new HttpError(404, 'Rule not found');
    const v = validateRuleInput(req.body ?? {}, await ruleContext(client, userId, pipelineId), ruleFromDb(cur.rows[0]));
    if (!v.ok) throw new HttpError(400, v.errors.join('; '), { errors: v.errors });
    const r = await client.query<RuleRowDb>(
      `UPDATE crm_rules
          SET from_stage_id = $3, name = $4, priority = $5, is_active = $6, trigger = $7,
              conditions = $8::jsonb, actions = $9::jsonb, forward_only = $10, updated_at = now()
        WHERE id = $1 AND pipeline_id = $2 RETURNING *`,
      [ruleId, pipelineId, v.value.fromStageId, v.value.name, v.value.priority, v.value.isActive, v.value.trigger,
        JSON.stringify(v.value.conditions), JSON.stringify(v.value.actions), v.value.forwardOnly]
    );
    return r.rows[0]!;
  });
  res.json({ rule: ruleOut(rule) });
});

export const deleteRule = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  const ruleId = idParam(req, 'ruleId');
  await ownPipeline(dbPool, userId, pipelineId);
  const r = await dbPool.query(`DELETE FROM crm_rules WHERE id = $1 AND pipeline_id = $2`, [ruleId, pipelineId]);
  if (!r.rowCount) throw new HttpError(404, 'Rule not found');
  res.json({ ok: true });
});

/** POST /pipelines/:id/rules/test { contactId, trigger?, label? }: which rules would match this lead now. Changes nothing. */
export const testRules = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = idParam(req, 'id');
  await ownPipeline(dbPool, userId, pipelineId);
  const contactId = Number(req.body?.contactId);
  if (!Number.isInteger(contactId) || contactId < 1) throw new HttpError(400, 'contactId is required');
  const trigger = req.body?.trigger ? String(req.body.trigger) : null;
  if (trigger && !RULE_TRIGGERS.includes(trigger as (typeof RULE_TRIGGERS)[number])) throw new HttpError(400, 'Unknown trigger');
  const label = req.body?.label ? String(req.body.label) : null;
  if (label && !isReplyLabel(label)) throw new HttpError(400, 'Unknown reply label');
  const out = await dryRunRules(userId, pipelineId, contactId, { trigger, label });
  if (!out) throw new HttpError(404, 'Lead not found in this pipeline');
  res.json(out);
});

// ─── lookups for the builder ────────────────────────────────────────────────

/** GET /contacts/lookup?pipelineId=&search=  (max 20, for the Test picker) */
export const lookupContacts = handle(async (req, res) => {
  const userId = userIdOf(req);
  const pipelineId = Number(req.query.pipelineId);
  const search = String(req.query.search ?? '').trim();
  const r = await dbPool.query(
    `SELECT cc.id, cc.email, cc.name, s.name AS stage_name
       FROM crm_contacts cc LEFT JOIN crm_pipeline_stages s ON s.id = cc.stage_id
      WHERE cc.user_id = $1
        AND ($2::int IS NULL OR cc.pipeline_id = $2)
        AND ($3 = '' OR cc.email ILIKE '%' || $3 || '%' OR cc.name ILIKE '%' || $3 || '%')
      ORDER BY cc.updated_at DESC, cc.id DESC
      LIMIT 20`,
    [userId, Number.isInteger(pipelineId) ? pipelineId : null, search.slice(0, 100)]
  );
  res.json({ contacts: r.rows.map((c) => ({ id: c.id, email: c.email, name: c.name, stageName: c.stage_name })) });
});

/** GET /tags: the user's lead tags (managed in step 5), for has_tag conditions and add/remove tag actions. */
export const listTags = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query(
    `SELECT id, name, color FROM crm_tags WHERE user_id = $1 AND scope <> 'campaign' ORDER BY lower(name)`,
    [userId]
  );
  res.json({ tags: r.rows });
});
