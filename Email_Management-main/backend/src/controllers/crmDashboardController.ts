/**
 * CRM step 8: dashboard APIs. Mounted in crmRouter at /api/crm (auth + crmEnabled plan check).
 *
 *   PATCH /crm/contacts/:id/stage {stageId}   manual move (drag and drop), writes stage history
 *   GET   /crm/summary?<lead filters>          KPIs, count per stage and label, funnel, average days in stage
 *   GET   /crm/contacts/export?<lead filters>  CSV of the filtered leads (at most 10 000)
 *
 * Lead filters: see lib/crm/contactFilters.ts. Every query is scoped to the logged-in user.
 */
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { dbPool } from '../lib/db.js';
import { emitCrmEvent } from '../lib/crm/events.js';
import { moveContactsManually } from '../lib/crm/contactActions.js';
import { FilterError, contactOrderSql, contactWhereSql, parseContactFilters, type ContactFilters } from '../lib/crm/contactFilters.js';
import { REPLY_LABELS, REPLY_LABEL_META, isReplyLabel } from '../constants/replyLabels.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function userIdOf(req: Request): number {
  const id = req.user?.id;
  if (!id) throw new HttpError(401, 'Unauthorized');
  return id;
}

function filtersOf(req: Request): ContactFilters {
  try {
    return parseContactFilters(req.query as Record<string, unknown>);
  } catch (err) {
    if (err instanceof FilterError) throw new HttpError(400, err.message);
    throw err;
  }
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[crm dashboard]', err);
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

// ─── PATCH /crm/contacts/:id/stage ───────────────────────────────────────────

export const moveContactStage = handle(async (req, res) => {
  const userId = userIdOf(req);
  const contactId = Number(req.params.id);
  const stageId = Number(req.body?.stageId);
  if (!Number.isInteger(contactId) || contactId < 1) throw new HttpError(400, 'Invalid id');
  if (!Number.isInteger(stageId) || stageId < 1) throw new HttpError(400, 'Pick a stage');

  const out = await inTransaction(async (client) => {
    const c = await client.query<{ id: number; stage_id: number | null }>(`SELECT id, stage_id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [contactId, userId]);
    if (!c.rows[0]) throw new HttpError(404, 'Lead not found');
    const s = await client.query<{ id: number; pipeline_id: number; name: string; color: string; type: string; stop_follow_ups: boolean }>(
      `SELECT s.id, s.pipeline_id, s.name, s.color, s.type, s.stop_follow_ups
         FROM crm_pipeline_stages s JOIN crm_pipelines p ON p.id = s.pipeline_id
        WHERE s.id = $1 AND p.user_id = $2`,
      [stageId, userId]
    );
    const stage = s.rows[0];
    if (!stage) throw new HttpError(404, 'Stage not found');
    const moves = await moveContactsManually(client, userId, [contactId], {
      id: stage.id,
      pipelineId: stage.pipeline_id,
      name: stage.name,
      stopFollowUps: stage.stop_follow_ups,
    });
    return { moves, stage };
  });

  // Rules with the "manual move" trigger (and the score) run after the move is saved.
  for (const m of out.moves) {
    void emitCrmEvent(userId, m.contactId, { type: 'manual_move', data: { fromStageId: m.fromStageId, toStageId: m.toStageId } }).catch((err) =>
      console.error('[crm] manual_move event failed:', err)
    );
  }
  res.json({
    ok: true,
    moved: out.moves.length > 0,
    stage: { id: out.stage.id, pipelineId: out.stage.pipeline_id, name: out.stage.name, color: out.stage.color, type: out.stage.type },
  });
});

// ─── GET /crm/summary ────────────────────────────────────────────────────────

type StageRow = { id: number; name: string; color: string; type: string; position: number };

/**
 * Funnel: a lead "reached" a stage when it is in that stage or a later one now, or was there before
 * (stage history). Lost stages are not part of the funnel. Pure: unit tested.
 */
export function buildFunnel(stages: StageRow[], maxPositions: Array<number | { pos: number; n: number }>) {
  // One entry per lead (a number), or one per position with a count (step 9: grouped in SQL).
  const groups = maxPositions.map((m) => (typeof m === 'number' ? { pos: m, n: 1 } : m));
  const reachedAt = (position: number) => groups.reduce((sum, g) => (g.pos >= position ? sum + g.n : sum), 0);
  const steps = stages.filter((s) => s.type !== 'lost').sort((a, b) => a.position - b.position);
  return steps.map((s, i) => {
    const reached = reachedAt(s.position);
    const prev = i > 0 ? reachedAt(steps[i - 1]!.position) : null;
    return {
      stageId: s.id,
      name: s.name,
      color: s.color,
      type: s.type,
      reached,
      conversionFromPrev: prev == null ? null : prev === 0 ? 0 : Math.round((reached / prev) * 1000) / 10,
    };
  });
}

export const getSummary = handle(async (req, res) => {
  const userId = userIdOf(req);
  const filters = filtersOf(req);

  // The board shows one pipeline: the chosen one, or the default pipeline.
  const pipe = await dbPool.query<{ id: number; name: string }>(
    `SELECT id, name FROM crm_pipelines WHERE user_id = $1 AND ($2::int IS NULL OR id = $2) ORDER BY is_default DESC, id ASC LIMIT 1`,
    [userId, filters.pipelineId]
  );
  const pipeline = pipe.rows[0];
  if (!pipeline) {
    if (filters.pipelineId != null) throw new HttpError(404, 'Pipeline not found');
    res.json({ pipeline: null, kpis: null, stages: [], labels: {}, funnel: [] });
    return;
  }

  const { where, params } = contactWhereSql(userId, { ...filters, pipelineId: pipeline.id }, { stageId: true });
  const pp = params.length + 1;
  const all = [...params, pipeline.id];

  const [kpis, stages, perStage, avgDays, labels, maxPos] = await Promise.all([
    dbPool.query<{ total: number; interested: number; meetings: number; won: number; lost: number; needs_reply: number; hot: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE cc.last_reply_label = 'interested')::int AS interested,
              count(*) FILTER (WHERE cc.last_reply_label = 'meeting_booked')::int AS meetings,
              count(*) FILTER (WHERE s.type = 'won')::int AS won,
              count(*) FILTER (WHERE s.type = 'lost')::int AS lost,
              count(*) FILTER (WHERE cc.needs_reply AND (cc.snoozed_until IS NULL OR cc.snoozed_until <= now()))::int AS needs_reply,
              count(*) FILTER (WHERE cc.score_tier = 'hot')::int AS hot
         FROM crm_contacts cc LEFT JOIN crm_pipeline_stages s ON s.id = cc.stage_id
        WHERE ${where}`,
      params
    ),
    dbPool.query<StageRow>(`SELECT id, name, color, type, position FROM crm_pipeline_stages WHERE pipeline_id = $1 ORDER BY position, id`, [pipeline.id]),
    dbPool.query<{ stage_id: number; n: number }>(`SELECT cc.stage_id, count(*)::int AS n FROM crm_contacts cc WHERE ${where} GROUP BY cc.stage_id`, params),
    dbPool.query<{ stage_id: number; days: string | number }>(
      `WITH h AS (
         SELECT h.to_stage_id, h.created_at,
                LEAD(h.created_at) OVER (PARTITION BY h.contact_id ORDER BY h.created_at, h.id) AS left_at
           FROM crm_stage_history h
          WHERE h.contact_id IN (SELECT cc.id FROM crm_contacts cc WHERE ${where}))
       SELECT to_stage_id AS stage_id, avg(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - created_at)) / 86400) AS days
         FROM h WHERE to_stage_id IS NOT NULL GROUP BY 1`,
      params
    ),
    dbPool.query<{ label: string; n: number }>(
      `SELECT COALESCE(cc.last_reply_label, 'none') AS label, count(*)::int AS n FROM crm_contacts cc WHERE ${where} GROUP BY 1`,
      params
    ),
    // Furthest stage each lead reached (history or now), counted per position.
    // Step 9: grouped in SQL instead of one sub-query per lead (450 ms -> 110 ms with 50k leads).
    dbPool.query<{ maxpos: number; n: number }>(
      `WITH hm AS (
         SELECT h.contact_id, max(s2.position) AS p
           FROM crm_stage_history h JOIN crm_pipeline_stages s2 ON s2.id = h.to_stage_id
          WHERE s2.pipeline_id = $${pp} AND s2.type <> 'lost'
            AND h.contact_id IN (SELECT cc.id FROM crm_contacts cc WHERE ${where})
          GROUP BY h.contact_id)
       SELECT GREATEST(COALESCE(hm.p, -1), COALESCE(s3.position, -1)) AS maxpos, count(*)::int AS n
         FROM crm_contacts cc
         LEFT JOIN hm ON hm.contact_id = cc.id
         LEFT JOIN crm_pipeline_stages s3 ON s3.id = cc.stage_id AND s3.type <> 'lost'
        WHERE ${where}
        GROUP BY 1`,
      all
    ),
  ]);

  const k = kpis.rows[0]!;
  const counts = new Map(perStage.rows.map((r) => [r.stage_id, r.n]));
  const days = new Map(avgDays.rows.map((r) => [r.stage_id, Number(r.days)]));
  const labelCounts: Record<string, number> = Object.fromEntries([...REPLY_LABELS, 'none'].map((l) => [l, 0]));
  for (const r of labels.rows) labelCounts[r.label] = r.n;

  res.json({
    pipeline,
    kpis: {
      total: k.total,
      interested: k.interested,
      meetings: k.meetings,
      won: k.won,
      lost: k.lost,
      /** Won ÷ (Won + Lost), in % (null until a lead is won or lost). */
      winRate: k.won + k.lost > 0 ? Math.round((k.won / (k.won + k.lost)) * 1000) / 10 : null,
      needsReply: k.needs_reply,
      hot: k.hot,
    },
    stages: stages.rows.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      type: s.type,
      position: s.position,
      count: counts.get(s.id) ?? 0,
      avgDaysInStage: days.has(s.id) ? Math.round(days.get(s.id)! * 10) / 10 : null,
    })),
    labels: labelCounts,
    funnel: buildFunnel(stages.rows, maxPos.rows.map((r) => ({ pos: Number(r.maxpos), n: Number(r.n) }))),
  });
});

// ─── GET /crm/contacts/export ────────────────────────────────────────────────

/** One CSV cell. Values that a spreadsheet would run as a formula get a leading quote. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const exportContactsCsv = handle(async (req, res) => {
  const userId = userIdOf(req);
  const filters = filtersOf(req);
  const { where, params } = contactWhereSql(userId, filters);
  const rows = await dbPool.query<{
    name: string | null; email: string; company: string | null; pipeline: string | null; stage: string | null; label: string | null;
    score: number; score_tier: string; tags: string | null; needs_reply: boolean; needs_reply_since: string | null;
    last_inbound_at: string | null; last_outbound_at: string | null; open_count: number; created_at: string;
  }>(
    `SELECT cc.name, cc.email, cc.company, p.name AS pipeline, s.name AS stage, cc.last_reply_label AS label, cc.score, cc.score_tier,
            (SELECT string_agg(t.name, '; ' ORDER BY lower(t.name)) FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id WHERE ct.contact_id = cc.id) AS tags,
            cc.needs_reply, cc.needs_reply_since, cc.last_inbound_at, cc.last_outbound_at, cc.open_count, cc.created_at
       FROM crm_contacts cc
       LEFT JOIN crm_pipeline_stages s ON s.id = cc.stage_id
       LEFT JOIN crm_pipelines p ON p.id = cc.pipeline_id
      WHERE ${where}
      ORDER BY ${contactOrderSql(req.query.sort)}
      LIMIT 10000`,
    params
  );
  const header = ['Name', 'Email', 'Company', 'Pipeline', 'Stage', 'Reply label', 'Score', 'Tier', 'Tags', 'Needs reply', 'Waiting since', 'Last reply', 'Last email sent', 'Opens', 'Added'];
  const day = (v: string | null) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : '');
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows.rows) {
    lines.push(
      [
        r.name, r.email, r.company, r.pipeline, r.stage, isReplyLabel(r.label) ? REPLY_LABEL_META[r.label].name : '', r.score, r.score_tier,
        r.tags, r.needs_reply ? 'yes' : 'no', day(r.needs_reply_since), day(r.last_inbound_at), day(r.last_outbound_at), r.open_count, day(r.created_at),
      ].map(csvCell).join(',')
    );
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="crm-leads-${stamp}.csv"`);
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});
