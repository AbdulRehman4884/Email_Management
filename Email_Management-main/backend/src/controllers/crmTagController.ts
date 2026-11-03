/**
 * CRM step 5: tags on campaigns and leads, campaign CRM info, the leads list and bulk actions.
 *
 * Routes (all behind auth + the crmEnabled plan check):
 *   /api/tags ...                          crmTagsRouter (CRUD)
 *   /api/campaigns/:id/tags/:tagId         crmTagsRouter (tag / untag a campaign)
 *   /api/crm/campaign-tags, /api/crm/campaigns/:id/..., /api/crm/contacts/...   crmRouter
 *
 * Every query is scoped to the logged-in user: an id from another user always answers 404.
 */
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { dbPool } from '../lib/db.js';
import { emitCrmEvent } from '../lib/crm/events.js';
import { moveContactsManually } from '../lib/crm/contactActions.js';
import {
  MAX_BULK_CONTACTS,
  MAX_TAGS_PER_USER,
  TAG_COLORS,
  applyAutoTagsToCampaign,
  campaignLabelBreakdown,
  cleanIdList,
  deactivateRulesUsingTag,
  getCampaignSettings,
  ownTagIds,
  validateTagInput,
} from '../lib/crm/tags.js';
import { recalcScoresQuietly } from '../lib/crm/leadScoring.js';
import { FilterError, contactOrderSql, contactWhereSql, parseContactFilters } from '../lib/crm/contactFilters.js';
import { contactTimeline } from '../lib/crm/contactTimeline.js';

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

function idParam(req: Request, name: string): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

function optInt(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id in filter');
  return n;
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
      if ((err as { code?: string })?.code === '23505') {
        res.status(409).json({ error: 'A tag with this name already exists' });
        return;
      }
      console.error('[crm tags]', err);
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

type Db = Pick<PoolClient, 'query'>;

type TagRow = { id: number; name: string; color: string; scope: string; created_at?: string; contact_count?: number; campaign_count?: number };
const tagOut = (t: TagRow) => ({
  id: t.id,
  name: t.name,
  color: t.color,
  scope: t.scope,
  contactCount: t.contact_count ?? 0,
  campaignCount: t.campaign_count ?? 0,
  createdAt: t.created_at,
});

async function ownTag(db: Db, userId: number, tagId: number): Promise<TagRow> {
  const r = await db.query<TagRow>(`SELECT id, name, color, scope FROM crm_tags WHERE id = $1 AND user_id = $2`, [tagId, userId]);
  if (!r.rows[0]) throw new HttpError(404, 'Tag not found');
  return r.rows[0];
}

async function ownCampaign(db: Db, userId: number, campaignId: number): Promise<{ id: number; name: string }> {
  const r = await db.query<{ id: number; name: string }>(`SELECT id, name FROM campaigns WHERE id = $1 AND user_id = $2`, [campaignId, userId]);
  if (!r.rows[0]) throw new HttpError(404, 'Campaign not found');
  return r.rows[0];
}

async function ownContact(db: Db, userId: number, contactId: number): Promise<{ id: number }> {
  const r = await db.query<{ id: number }>(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [contactId, userId]);
  if (!r.rows[0]) throw new HttpError(404, 'Lead not found');
  return r.rows[0];
}

async function assertTagNameFree(db: Db, userId: number, name: string, exceptId?: number) {
  const r = await db.query(
    `SELECT 1 FROM crm_tags WHERE user_id = $1 AND lower(name) = lower($2) AND ($3::int IS NULL OR id <> $3)`,
    [userId, name, exceptId ?? null]
  );
  if (r.rowCount) throw new HttpError(409, `A tag named "${name}" already exists`);
}

/** Tags of many leads at once: Map<contactId, tag[]>. */
async function tagsOfContacts(db: Db, contactIds: number[]) {
  const map = new Map<number, Array<{ id: number; name: string; color: string }>>();
  if (contactIds.length === 0) return map;
  const r = await db.query<{ contact_id: number; id: number; name: string; color: string }>(
    `SELECT ct.contact_id, t.id, t.name, t.color
       FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id
      WHERE ct.contact_id = ANY($1::int[])
      ORDER BY lower(t.name)`,
    [contactIds]
  );
  for (const row of r.rows) {
    const list = map.get(row.contact_id) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    map.set(row.contact_id, list);
  }
  return map;
}

/** Fire-and-forget: lets 'manual_move' rules run after a hand move. */
function emitManualMoves(userId: number, moves: Array<{ contactId: number; fromStageId: number | null; toStageId: number }>) {
  if (moves.length === 0) return;
  void (async () => {
    for (const m of moves) {
      await emitCrmEvent(userId, m.contactId, { type: 'manual_move', data: { fromStageId: m.fromStageId, toStageId: m.toStageId } });
    }
  })().catch((err) => console.error('[crm] manual_move events failed:', err));
}

// ─── /api/tags ──────────────────────────────────────────────────────────────

/** GET /tags: all tags with how many leads and campaigns use them. */
export const listAllTags = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query<TagRow>(
    `SELECT t.id, t.name, t.color, t.scope, t.created_at,
            (SELECT count(*)::int FROM crm_contact_tags ct WHERE ct.tag_id = t.id) AS contact_count,
            (SELECT count(*)::int FROM crm_campaign_tags ca WHERE ca.tag_id = t.id) AS campaign_count
       FROM crm_tags t
      WHERE t.user_id = $1
      ORDER BY lower(t.name)`,
    [userId]
  );
  res.json({ tags: r.rows.map(tagOut), colors: TAG_COLORS });
});

/** POST /tags {name, color?, scope?} */
export const createTag = handle(async (req, res) => {
  const userId = userIdOf(req);
  const v = validateTagInput(req.body ?? {});
  if (!v.ok) throw new HttpError(400, v.error);
  const tag = await inTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(42035, $1)', [userId]);
    const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_tags WHERE user_id = $1`, [userId]);
    if ((count.rows[0]?.n ?? 0) >= MAX_TAGS_PER_USER) throw new HttpError(400, `You can have at most ${MAX_TAGS_PER_USER} tags`);
    await assertTagNameFree(client, userId, v.value.name!);
    const r = await client.query<TagRow>(
      `INSERT INTO crm_tags (user_id, name, color, scope) VALUES ($1, $2, $3, $4)
       RETURNING id, name, color, scope, created_at`,
      [userId, v.value.name, v.value.color, v.value.scope]
    );
    return r.rows[0]!;
  });
  res.status(201).json({ tag: tagOut(tag) });
});

/** PATCH /tags/:tagId {name?, color?, scope?} */
export const updateTag = handle(async (req, res) => {
  const userId = userIdOf(req);
  const tagId = idParam(req, 'tagId');
  const v = validateTagInput(req.body ?? {}, true);
  if (!v.ok) throw new HttpError(400, v.error);
  const tag = await inTransaction(async (client) => {
    const old = await ownTag(client, userId, tagId);
    if (v.value.name && v.value.name.toLowerCase() !== old.name.toLowerCase()) {
      await assertTagNameFree(client, userId, v.value.name, tagId);
    }
    const r = await client.query<TagRow>(
      `UPDATE crm_tags SET name = COALESCE($2, name), color = COALESCE($3, color), scope = COALESCE($4, scope)
        WHERE id = $1
        RETURNING id, name, color, scope, created_at`,
      [tagId, v.value.name ?? null, v.value.color ?? null, v.value.scope ?? null]
    );
    return r.rows[0]!;
  });
  res.json({ tag: tagOut(tag) });
});

/** DELETE /tags/:tagId: removes it from leads and campaigns, and turns off rules that use it. */
export const deleteTag = handle(async (req, res) => {
  const userId = userIdOf(req);
  const tagId = idParam(req, 'tagId');
  const out = await inTransaction(async (client) => {
    const tag = await ownTag(client, userId, tagId);
    const tagged = await client.query<{ contact_id: number }>(`SELECT contact_id FROM crm_contact_tags WHERE tag_id = $1`, [tagId]);
    const rulesTurnedOff = await deactivateRulesUsingTag(client, userId, tag);
    await client.query(
      `UPDATE crm_campaign_settings SET auto_tag_ids = array_remove(auto_tag_ids, $2), updated_at = now()
        WHERE user_id = $1 AND $2 = ANY(auto_tag_ids)`,
      [userId, tagId]
    );
    await client.query(`DELETE FROM crm_tags WHERE id = $1`, [tagId]);
    return { rulesTurnedOff, contactIds: tagged.rows.map((r) => r.contact_id) };
  });
  void recalcScoresQuietly(out.contactIds); // step 7: tag points may change
  res.json({ ok: true, rulesTurnedOff: out.rulesTurnedOff });
});

// ─── campaign tags ──────────────────────────────────────────────────────────

/** POST /campaigns/:id/tags/:tagId */
export const addCampaignTag = handle(async (req, res) => {
  const userId = userIdOf(req);
  const campaignId = idParam(req, 'id');
  const tagId = idParam(req, 'tagId');
  await ownCampaign(dbPool, userId, campaignId);
  const tag = await ownTag(dbPool, userId, tagId);
  if (tag.scope === 'contact') throw new HttpError(400, `"${tag.name}" is a lead-only tag`);
  await dbPool.query(`INSERT INTO crm_campaign_tags (campaign_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [campaignId, tagId]);
  res.json({ ok: true });
});

/** DELETE /campaigns/:id/tags/:tagId */
export const removeCampaignTag = handle(async (req, res) => {
  const userId = userIdOf(req);
  const campaignId = idParam(req, 'id');
  const tagId = idParam(req, 'tagId');
  await ownCampaign(dbPool, userId, campaignId);
  await ownTag(dbPool, userId, tagId);
  await dbPool.query(`DELETE FROM crm_campaign_tags WHERE campaign_id = $1 AND tag_id = $2`, [campaignId, tagId]);
  res.json({ ok: true });
});

/** GET /crm/campaign-tags: tag ids per campaign, for the campaign list (chips + filter). */
export const campaignTagMap = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query<{ campaign_id: number; tag_ids: number[] }>(
    `SELECT ca.campaign_id, array_agg(ca.tag_id ORDER BY ca.tag_id) AS tag_ids
       FROM crm_campaign_tags ca JOIN campaigns c ON c.id = ca.campaign_id
      WHERE c.user_id = $1
      GROUP BY ca.campaign_id`,
    [userId]
  );
  const tags = await dbPool.query<TagRow>(`SELECT id, name, color, scope FROM crm_tags WHERE user_id = $1 ORDER BY lower(name)`, [userId]);
  res.json({
    tags: tags.rows.map(tagOut),
    campaigns: Object.fromEntries(r.rows.map((x) => [x.campaign_id, x.tag_ids.map(Number)])),
  });
});

/** GET /crm/campaigns/:id: tags, CRM settings and the reply-label breakdown of one campaign. */
export const campaignCrmSummary = handle(async (req, res) => {
  const userId = userIdOf(req);
  const campaignId = idParam(req, 'id');
  const campaign = await ownCampaign(dbPool, userId, campaignId);
  const [tags, settings, labels, leads] = await Promise.all([
    dbPool.query<TagRow>(
      `SELECT t.id, t.name, t.color, t.scope FROM crm_campaign_tags ca JOIN crm_tags t ON t.id = ca.tag_id
        WHERE ca.campaign_id = $1 ORDER BY lower(t.name)`,
      [campaignId]
    ),
    getCampaignSettings(dbPool, campaignId),
    campaignLabelBreakdown(campaignId),
    dbPool.query<{ n: number }>(`SELECT count(DISTINCT contact_id)::int AS n FROM crm_contact_recipients WHERE campaign_id = $1`, [campaignId]),
  ]);
  res.json({
    campaign,
    tags: tags.rows.map(tagOut),
    settings,
    labels,
    labeledLeads: Object.values(labels).reduce((a, b) => a + b, 0),
    leadCount: leads.rows[0]?.n ?? 0,
  });
});

/**
 * PUT /crm/campaigns/:id/settings {pipelineId, autoTagIds}
 * New leads of the campaign start in pipelineId (null = default pipeline). autoTagIds are added to
 * every lead of the campaign, now (leads that exist already) and later (new leads).
 */
export const saveCampaignSettings = handle(async (req, res) => {
  const userId = userIdOf(req);
  const campaignId = idParam(req, 'id');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pipelineId = optInt(body.pipelineId);
  const tagIds = cleanIdList(body.autoTagIds, 20);
  if (tagIds === null) throw new HttpError(400, 'autoTagIds must be a list of tag ids (at most 20)');

  const out = await inTransaction(async (client) => {
    await ownCampaign(client, userId, campaignId);
    if (pipelineId != null) {
      const p = await client.query(`SELECT 1 FROM crm_pipelines WHERE id = $1 AND user_id = $2`, [pipelineId, userId]);
      if (!p.rowCount) throw new HttpError(404, 'Pipeline not found');
    }
    const own = await ownTagIds(client, userId, tagIds);
    if (own.length !== tagIds.length) throw new HttpError(404, 'Tag not found');
    const lead = await client.query<{ id: number; name: string; scope: string }>(
      `SELECT id, name, scope FROM crm_tags WHERE id = ANY($1::int[]) AND scope = 'campaign'`,
      [own]
    );
    if (lead.rows[0]) throw new HttpError(400, `"${lead.rows[0].name}" is a campaign-only tag and cannot go on leads`);
    await client.query(
      `INSERT INTO crm_campaign_settings (campaign_id, user_id, pipeline_id, auto_tag_ids)
       VALUES ($1, $2, $3, $4::int[])
       ON CONFLICT (campaign_id) DO UPDATE
         SET pipeline_id = EXCLUDED.pipeline_id, auto_tag_ids = EXCLUDED.auto_tag_ids, updated_at = now()`,
      [campaignId, userId, pipelineId, own]
    );
    const tagged = await applyAutoTagsToCampaign(client, campaignId);
    return { settings: { pipelineId, autoTagIds: own }, tagged };
  });
  if (out.tagged > 0) {
    const leads = await dbPool.query<{ contact_id: number }>(`SELECT DISTINCT contact_id FROM crm_contact_recipients WHERE campaign_id = $1`, [campaignId]);
    void recalcScoresQuietly(leads.rows.map((r) => r.contact_id)); // step 7: tag points may change
  }
  res.json(out);
});

// ─── leads ──────────────────────────────────────────────────────────────────

type ContactListRow = {
  id: number; email: string; name: string | null; company: string | null; pipeline_id: number | null;
  stage_id: number | null; stage_name: string | null; stage_color: string | null; stage_type: string | null;
  score: number; score_tier: string; last_reply_label: string | null; last_inbound_at: string | null;
  last_outbound_at: string | null; needs_reply: boolean; follow_ups_stopped: boolean; stage_stop_follow_ups: boolean | null; open_count: number;
  campaign_count: number; updated_at: string; needs_reply_since: string | null; snoozed_until: string | null; created_at: string;
};
const contactOut = (c: ContactListRow, tags: Array<{ id: number; name: string; color: string }>) => ({
  id: c.id,
  email: c.email,
  name: c.name,
  company: c.company,
  pipelineId: c.pipeline_id,
  stageId: c.stage_id,
  stageName: c.stage_name,
  stageColor: c.stage_color,
  stageType: c.stage_type,
  score: c.score,
  scoreTier: c.score_tier,
  lastReplyLabel: c.last_reply_label,
  lastInboundAt: c.last_inbound_at,
  lastOutboundAt: c.last_outbound_at,
  needsReply: c.needs_reply,
  needsReplySince: c.needs_reply_since,
  snoozedUntil: c.snoozed_until,
  addedAt: c.created_at,
  // CRM-04: a lead in a stage with "Stop follow-ups" (e.g. Won/Lost) gets no follow-ups (followUps.ts
  // checks the same), so it is shown as stopped too; the reason tells the lead flag and the stage apart.
  followUpsStopped: c.follow_ups_stopped || c.stage_stop_follow_ups === true,
  followUpsStoppedBy: c.follow_ups_stopped ? 'lead' : c.stage_stop_follow_ups ? 'stage' : null,
  openCount: c.open_count,
  campaignCount: c.campaign_count,
  updatedAt: c.updated_at,
  tags,
});

const CONTACT_COLUMNS = `
  cc.id, cc.email, cc.name, cc.company, cc.pipeline_id, cc.stage_id, s.name AS stage_name, s.color AS stage_color,
  s.type AS stage_type, cc.score, cc.score_tier, cc.last_reply_label, cc.last_inbound_at, cc.last_outbound_at,
  cc.needs_reply, cc.follow_ups_stopped, s.stop_follow_ups AS stage_stop_follow_ups, cc.open_count, cc.updated_at, cc.needs_reply_since, cc.snoozed_until, cc.created_at,
  (SELECT count(DISTINCT x.campaign_id)::int FROM crm_contact_recipients x WHERE x.contact_id = cc.id) AS campaign_count`;

/**
 * GET /crm/contacts — leads list with server-side filters (see lib/crm/contactFilters.ts):
 *   pipelineId, stageId, campaignId, label (comma list, 'none'), tagIds, scoreTier, needsReply, hotOnly,
 *   from, to (lead added, YYYY-MM-DD), search, sort=recent|score|name|hot|waiting|added, limit, page or offset.
 */
export const listContacts = handle(async (req, res) => {
  const userId = userIdOf(req);
  const q = req.query as Record<string, unknown>;
  let filters;
  try {
    filters = parseContactFilters(q);
  } catch (err) {
    if (err instanceof FilterError) throw new HttpError(400, err.message);
    throw err;
  }
  const { where: whereSql, params } = contactWhereSql(userId, filters);
  const orderBy = contactOrderSql(q.sort);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
  const page = Math.max(1, Math.min(10000, Number(q.page) || 0));
  const offset = q.page != null && q.page !== '' ? (page - 1) * limit : Math.max(0, Math.min(100000, Number(q.offset) || 0));

  const [rows, total] = await Promise.all([
    dbPool.query<ContactListRow>(
      `SELECT ${CONTACT_COLUMNS}
         FROM crm_contacts cc LEFT JOIN crm_pipeline_stages s ON s.id = cc.stage_id
        WHERE ${whereSql}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_contacts cc WHERE ${whereSql}`, params),
  ]);
  const tags = await tagsOfContacts(dbPool, rows.rows.map((r) => r.id));
  res.json({
    contacts: rows.rows.map((c) => contactOut(c, tags.get(c.id) ?? [])),
    total: total.rows[0]?.n ?? 0,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
  });
});

/** GET /crm/contacts/:id: one lead with tags, campaigns, latest replies and stage history. */
export const getContact = handle(async (req, res) => {
  const userId = userIdOf(req);
  const contactId = idParam(req, 'id');
  const r = await dbPool.query<ContactListRow & { custom_fields: Record<string, string> | null; notes: string | null; pipeline_name: string | null; stage_entered_at: string | null; created_at: string }>(
    `SELECT ${CONTACT_COLUMNS}, cc.custom_fields, cc.notes, cc.stage_entered_at, cc.created_at, p.name AS pipeline_name
       FROM crm_contacts cc
       LEFT JOIN crm_pipeline_stages s ON s.id = cc.stage_id
       LEFT JOIN crm_pipelines p ON p.id = cc.pipeline_id
      WHERE cc.id = $1 AND cc.user_id = $2`,
    [contactId, userId]
  );
  const c = r.rows[0];
  if (!c) throw new HttpError(404, 'Lead not found');

  const [tags, campaigns, replies, history, scoreInfo, timeline] = await Promise.all([
    tagsOfContacts(dbPool, [contactId]),
    dbPool.query(
      `SELECT c.id, c.name, r.id AS recipient_id, r.status, COALESCE(r.sent_ts, r.sent_at::timestamptz) AS sent_at, r.opened_at, r.replied_at
         FROM crm_contact_recipients x
         JOIN recipients r ON r.id = x.recipient_id
         JOIN campaigns c ON c.id = x.campaign_id
        WHERE x.contact_id = $1
        ORDER BY x.id DESC
        LIMIT 50`,
      [contactId]
    ),
    dbPool.query(
      `SELECT er.id, er.campaign_id, er.subject, left(COALESCE(er.body_text, ''), 300) AS snippet, er.direction,
              er.label, er.label_source, er.received_at, COALESCE(er.thread_root_id, er.id) AS thread_root_id
         FROM email_replies er
         JOIN crm_contact_recipients x ON x.recipient_id = er.recipient_id
        WHERE x.contact_id = $1
        ORDER BY er.received_at DESC, er.id DESC
        LIMIT 20`,
      [contactId]
    ),
    dbPool.query(
      `SELECT h.id, h.from_stage_id, fs.name AS from_name, h.to_stage_id, ts.name AS to_name, h.reason, h.rule_id,
              ru.name AS rule_name, h.created_at
         FROM crm_stage_history h
         LEFT JOIN crm_pipeline_stages fs ON fs.id = h.from_stage_id
         LEFT JOIN crm_pipeline_stages ts ON ts.id = h.to_stage_id
         LEFT JOIN crm_rules ru ON ru.id = h.rule_id
        WHERE h.contact_id = $1
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT 30`,
      [contactId]
    ),
    // Step 7: "why this score" (parts) + the latest score changes.
    Promise.all([
      dbPool.query<{ score_breakdown: unknown; score_updated_at: string | null }>(
        `SELECT score_breakdown, score_updated_at FROM crm_contacts WHERE id = $1`,
        [contactId]
      ),
      dbPool.query(
        `SELECT id, points, reason, source_type, created_at FROM crm_score_events WHERE contact_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30`,
        [contactId]
      ),
    ]),
    contactTimeline(contactId), // step 8
  ]);
  const [scoreRow, scoreEvents] = scoreInfo;

  res.json({
    contact: {
      ...contactOut(c, tags.get(contactId) ?? []),
      customFields: c.custom_fields ?? {},
      notes: c.notes,
      pipelineName: c.pipeline_name,
      stageEnteredAt: c.stage_entered_at,
      createdAt: c.created_at,
    },
    campaigns: campaigns.rows.map((x) => ({
      id: x.id, name: x.name, recipientId: x.recipient_id, status: x.status, sentAt: x.sent_at, openedAt: x.opened_at, repliedAt: x.replied_at,
    })),
    replies: replies.rows.map((x) => ({
      id: x.id, campaignId: x.campaign_id, subject: x.subject, snippet: x.snippet, direction: x.direction,
      label: x.label, labelSource: x.label_source, receivedAt: x.received_at, threadRootId: x.thread_root_id,
    })),
    history: history.rows.map((h) => ({
      id: h.id, fromStageId: h.from_stage_id, fromName: h.from_name, toStageId: h.to_stage_id, toName: h.to_name,
      reason: h.reason, ruleId: h.rule_id, ruleName: h.rule_name, at: h.created_at,
    })),
    score: {
      breakdown: Array.isArray(scoreRow.rows[0]?.score_breakdown) ? scoreRow.rows[0]!.score_breakdown : [],
      updatedAt: scoreRow.rows[0]?.score_updated_at ?? null,
      events: scoreEvents.rows.map((e) => ({ id: e.id, points: e.points, reason: e.reason, source: e.source_type, at: e.created_at })),
    },
    timeline,
  });
});

/** POST /crm/contacts/:id/tags/:tagId */
export const addContactTag = handle(async (req, res) => {
  const userId = userIdOf(req);
  const contactId = idParam(req, 'id');
  const tagId = idParam(req, 'tagId');
  await ownContact(dbPool, userId, contactId);
  const tag = await ownTag(dbPool, userId, tagId);
  if (tag.scope === 'campaign') throw new HttpError(400, `"${tag.name}" is a campaign-only tag`);
  await dbPool.query(`INSERT INTO crm_contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [contactId, tagId]);
  await dbPool.query(`UPDATE crm_contacts SET updated_at = now() WHERE id = $1`, [contactId]);
  await recalcScoresQuietly([contactId]); // step 7: tag points
  res.json({ ok: true });
});

/** DELETE /crm/contacts/:id/tags/:tagId */
export const removeContactTag = handle(async (req, res) => {
  const userId = userIdOf(req);
  const contactId = idParam(req, 'id');
  const tagId = idParam(req, 'tagId');
  await ownContact(dbPool, userId, contactId);
  await ownTag(dbPool, userId, tagId);
  await dbPool.query(`DELETE FROM crm_contact_tags WHERE contact_id = $1 AND tag_id = $2`, [contactId, tagId]);
  await dbPool.query(`UPDATE crm_contacts SET updated_at = now() WHERE id = $1`, [contactId]);
  await recalcScoresQuietly([contactId]); // step 7: tag points
  res.json({ ok: true });
});

/**
 * POST /crm/contacts/bulk {contactIds, addTagIds?, removeTagIds?, moveToStageId?}
 * Everything in one transaction: all or nothing. Leads of other users are ignored (counted as skipped).
 */
export const bulkUpdateContacts = handle(async (req, res) => {
  const userId = userIdOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const contactIds = cleanIdList(body.contactIds);
  const addTagIds = cleanIdList(body.addTagIds, 20);
  const removeTagIds = cleanIdList(body.removeTagIds, 20);
  if (contactIds === null || contactIds.length === 0) throw new HttpError(400, `contactIds: pick 1 to ${MAX_BULK_CONTACTS} leads`);
  if (addTagIds === null || removeTagIds === null) throw new HttpError(400, 'addTagIds / removeTagIds must be lists of tag ids (at most 20)');
  const moveToStageId = optInt(body.moveToStageId);
  if (!addTagIds.length && !removeTagIds.length && moveToStageId == null) throw new HttpError(400, 'Nothing to do: add tags, remove tags or pick a stage');
  if (addTagIds.some((id) => removeTagIds.includes(id))) throw new HttpError(400, 'A tag cannot be added and removed at the same time');

  const out = await inTransaction(async (client) => {
    const own = await client.query<{ id: number }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND id = ANY($2::int[])`, [userId, contactIds]);
    const ids = own.rows.map((r) => r.id);
    const tagRows = await client.query<{ id: number; name: string; scope: string }>(
      `SELECT id, name, scope FROM crm_tags WHERE user_id = $1 AND id = ANY($2::int[])`,
      [userId, [...addTagIds, ...removeTagIds]]
    );
    if (tagRows.rows.length !== addTagIds.length + removeTagIds.length) throw new HttpError(404, 'Tag not found');
    const campaignOnly = tagRows.rows.find((t) => t.scope === 'campaign' && addTagIds.includes(t.id));
    if (campaignOnly) throw new HttpError(400, `"${campaignOnly.name}" is a campaign-only tag`);

    let stage: { id: number; pipelineId: number; name: string; stopFollowUps: boolean } | null = null;
    if (moveToStageId != null) {
      const s = await client.query<{ id: number; pipeline_id: number; name: string; stop_follow_ups: boolean }>(
        `SELECT s.id, s.pipeline_id, s.name, s.stop_follow_ups FROM crm_pipeline_stages s
           JOIN crm_pipelines p ON p.id = s.pipeline_id
          WHERE s.id = $1 AND p.user_id = $2`,
        [moveToStageId, userId]
      );
      if (!s.rows[0]) throw new HttpError(404, 'Stage not found');
      stage = { id: s.rows[0].id, pipelineId: s.rows[0].pipeline_id, name: s.rows[0].name, stopFollowUps: s.rows[0].stop_follow_ups };
    }

    let tagsAdded = 0;
    let tagsRemoved = 0;
    if (ids.length && addTagIds.length) {
      const r = await client.query(
        `INSERT INTO crm_contact_tags (contact_id, tag_id)
         SELECT c, t FROM unnest($1::int[]) c CROSS JOIN unnest($2::int[]) t
         ON CONFLICT DO NOTHING`,
        [ids, addTagIds]
      );
      tagsAdded = r.rowCount ?? 0;
    }
    if (ids.length && removeTagIds.length) {
      const r = await client.query(`DELETE FROM crm_contact_tags WHERE contact_id = ANY($1::int[]) AND tag_id = ANY($2::int[])`, [ids, removeTagIds]);
      tagsRemoved = r.rowCount ?? 0;
    }
    const moves = stage ? await moveContactsManually(client, userId, ids, stage) : [];
    if (ids.length && (tagsAdded || tagsRemoved)) {
      await client.query(`UPDATE crm_contacts SET updated_at = now() WHERE id = ANY($1::int[])`, [ids]);
    }
    return { matched: ids.length, skipped: contactIds.length - ids.length, tagsAdded, tagsRemoved, moves, ids };
  });
  if (out.tagsAdded || out.tagsRemoved) await recalcScoresQuietly(out.ids); // step 7: tag points

  emitManualMoves(userId, out.moves);
  res.json({ ok: true, matched: out.matched, skipped: out.skipped, tagsAdded: out.tagsAdded, tagsRemoved: out.tagsRemoved, moved: out.moves.length });
});
