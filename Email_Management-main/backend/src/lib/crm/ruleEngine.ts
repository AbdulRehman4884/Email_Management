/**
 * CRM rule engine (step 3): WHEN trigger + IF conditions -> THEN actions.
 *
 * handleCrmEvent() is registered as a CRM event handler (see events.ts). For one contact + one event:
 *   1. lock the contact row (events for the same lead never run at the same time),
 *   2. update counters the event changes (open_count, last_outbound_at, follow-up stop on bounce/unsubscribe),
 *   3. load active rules of the contact's pipeline for this trigger, where from_stage is empty or the
 *      current stage, highest priority first,
 *   4. evaluate each rule's conditions; every matching rule runs its non-move actions; the first
 *      matching rule whose move is allowed moves the lead,
 *   5. after a move, rules are checked again from the new stage, at most MAX_MOVES_PER_EVENT moves.
 *
 * Loop safety (step 9): actions never emit new events, so one event can never start another.
 * Events that repeat on their own are limited per lead:
 *   - time_tick (every 30 min): notify_user and add_score run once per stage visit.
 *   - schedule_follow_up: once per rule per stage visit, and at most MAX_RULE_FOLLOW_UPS_PER_LEAD in total,
 *     so "follow-up sent -> schedule follow-up" cannot email a lead forever.
 *
 * Move policy (canAutoMove): never into or out of a manual-only stage, never out of a Won/Lost stage,
 * and with forward_only a lead only moves to a later stage (Won/Lost are always allowed as targets).
 */
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';
import { replyPlainText } from '../replyLabeling.js';
import type { CrmEvent } from './events.js';
import { evaluateConditions, type ConditionGroup, type ContactFacts } from './conditions.js';
import { seedDefaultRules } from './pipelines.js';
import { cancelPendingFollowUps } from './followUps.js';
import { recalcContactScore } from './leadScoring.js';

export const MAX_MOVES_PER_EVENT = 3;
/** Most follow-ups the schedule_follow_up action can plan for one lead, ever (cancelled/failed ones don't count). */
export const MAX_RULE_FOLLOW_UPS_PER_LEAD = 5;
/** Repeated pixel hits within this window count as one open. */
const OPEN_DEDUPE_SECONDS = 60;
const NOTIFY_DEDUPE_MINUTES = 10;

const recentOpensByRecipient = new Map<number, number>();

function isRecipientDuplicateOpen(recipientId: number): boolean {
  const now = Date.now();
  if (recentOpensByRecipient.size > 5000) {
    for (const [id, ts] of recentOpensByRecipient.entries()) {
      if (now - ts > 300_000) recentOpensByRecipient.delete(id);
    }
  }
  const last = recentOpensByRecipient.get(recipientId);
  if (last && now - last < OPEN_DEDUPE_SECONDS * 1000) {
    return true;
  }
  recentOpensByRecipient.set(recipientId, now);
  return false;
}

export { canAutoMove, type StageInfo, type MoveCheck } from './movePolicy.js';
import { canAutoMove, type StageInfo } from './movePolicy.js';

export interface RuleRow {
  id: number;
  name: string;
  priority: number;
  from_stage_id: number | null;
  conditions: ConditionGroup | null;
  actions: Array<Record<string, unknown>> | null;
  forward_only: boolean;
}

export interface ContactRow {
  id: number;
  user_id: number;
  email: string;
  name: string | null;
  pipeline_id: number | null;
  stage_id: number | null;
  score: number;
  last_reply_label: string | null;
  custom_fields: Record<string, string> | null;
  open_count: number;
  follow_ups_stopped: boolean;
  days_in_stage: number | string | null;
}

export interface EngineResult {
  skipped?: string;
  moves: Array<{ from: number | null; to: number; ruleId: number }>;
  actions: Array<{ ruleId: number; type: string; result: string }>;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function lockContact(client: PoolClient, contactId: number): Promise<ContactRow | null> {
  const r = await client.query<ContactRow>(
    `SELECT cc.id, cc.user_id, cc.email, cc.name, cc.pipeline_id, cc.stage_id, cc.score, cc.last_reply_label,
            cc.custom_fields, cc.open_count, cc.follow_ups_stopped,
            EXTRACT(EPOCH FROM (now() - cc.stage_entered_at)) / 86400 AS days_in_stage
       FROM crm_contacts cc
      WHERE cc.id = $1
      FOR UPDATE`,
    [contactId]
  );
  return r.rows[0] ?? null;
}

async function loadStages(client: PoolClient, pipelineId: number): Promise<Map<number, StageInfo>> {
  const r = await client.query<{ id: number; name: string; position: number; type: string; manual_only: boolean; stop_follow_ups: boolean }>(
    `SELECT id, name, position, type, manual_only, stop_follow_ups FROM crm_pipeline_stages WHERE pipeline_id = $1`,
    [pipelineId]
  );
  return new Map(
    r.rows.map((s) => [s.id, { id: s.id, name: s.name, position: s.position, type: s.type, manualOnly: s.manual_only, stopFollowUps: s.stop_follow_ups }])
  );
}

/** Updates the counters an event changes. Returns false when the event should be ignored (duplicate open). */
async function applyEventToContact(client: PoolClient, contact: ContactRow, event: CrmEvent): Promise<boolean> {
  switch (event.type) {
    case 'email_sent':
    case 'follow_up_sent':
      await client.query(`UPDATE crm_contacts SET last_outbound_at = now(), updated_at = now() WHERE id = $1`, [contact.id]);
      return true;
    case 'email_opened': {
      const recipientId = numOrNull(event.data?.recipientId);
      if (recipientId != null) {
        if (isRecipientDuplicateOpen(recipientId)) return false;
        const r = await client.query(
          `UPDATE crm_contacts
              SET open_count = open_count + 1, last_opened_at = now(), updated_at = now()
            WHERE id = $1
            RETURNING open_count`,
          [contact.id]
        );
        if (r.rowCount === 0) return false;
        contact.open_count = num(r.rows[0]?.open_count, contact.open_count + 1);
        return true;
      }
      const r = await client.query(
        `UPDATE crm_contacts
            SET open_count = open_count + 1, last_opened_at = now(), updated_at = now()
          WHERE id = $1 AND (last_opened_at IS NULL OR last_opened_at < now() - make_interval(secs => $2))
          RETURNING open_count`,
        [contact.id, OPEN_DEDUPE_SECONDS]
      );
      if (r.rowCount === 0) return false;
      contact.open_count = num(r.rows[0]?.open_count, contact.open_count + 1);
      return true;
    }
    case 'bounced':
      await stopFollowUps(client, contact.id, event.type);
      contact.follow_ups_stopped = true;
      await client.query(
        `UPDATE crm_contacts
            SET last_reply_label = 'bounce_unsubscribe', updated_at = now()
          WHERE id = $1`,
        [contact.id]
      );
      contact.last_reply_label = 'bounce_unsubscribe';
      return true;
    case 'unsubscribed':
      await stopFollowUps(client, contact.id, event.type);
      contact.follow_ups_stopped = true;
      return true;
    case 'reply_received': {
      const label = String(event.data?.label ?? '');
      if (label !== 'out_of_office') {
        await cancelPendingFollowUps(client, contact.id, 'lead replied');
      }
      return true;
    }
    default:
      return true;
  }
}

async function stopFollowUps(client: PoolClient, contactId: number, why: string): Promise<void> {
  await client.query(
    `UPDATE crm_contacts
        SET follow_ups_stopped = true, follow_ups_stopped_at = COALESCE(follow_ups_stopped_at, now()), updated_at = now()
      WHERE id = $1`,
    [contactId]
  );
  await cancelPendingFollowUps(client, contactId, `follow-ups stopped (${why})`);
}

/** Everything conditions can read, for this contact, now. */
export async function loadFacts(client: Pick<PoolClient, 'query'>, contact: ContactRow, stage: StageInfo | null, event: CrmEvent): Promise<ContactFacts> {
  const realReply = `er.direction = 'inbound' AND COALESCE(er.label, '') NOT IN ('out_of_office', 'bounce_unsubscribe')`;
  const r = await client.query<{
    reply_count: number;
    follow_up_count: number;
    days_since_last_reply: string | null;
    days_since_last_outbound: string | null;
    campaign_ids: number[] | null;
    tag_ids: number[] | null;
    tag_names: string[] | null;
  }>(
    `WITH links AS (SELECT recipient_id, campaign_id FROM crm_contact_recipients WHERE contact_id = $1)
     SELECT
       (SELECT count(*)::int FROM email_replies er WHERE er.recipient_id IN (SELECT recipient_id FROM links) AND ${realReply}) AS reply_count,
       (SELECT count(*)::int FROM email_replies er WHERE er.recipient_id IN (SELECT recipient_id FROM links) AND er.direction = 'outbound') AS follow_up_count,
       (SELECT EXTRACT(EPOCH FROM (now() - max(er.received_at::timestamptz))) / 86400
          FROM email_replies er WHERE er.recipient_id IN (SELECT recipient_id FROM links) AND ${realReply}) AS days_since_last_reply,
       (SELECT EXTRACT(EPOCH FROM (now() - GREATEST(
            (SELECT max(COALESCE(r.sent_ts, r.sent_at::timestamptz)) FROM recipients r WHERE r.id IN (SELECT recipient_id FROM links)),
            (SELECT max(er.received_at::timestamptz) FROM email_replies er
              WHERE er.recipient_id IN (SELECT recipient_id FROM links) AND er.direction = 'outbound')
          ))) / 86400) AS days_since_last_outbound,
       (SELECT array_agg(DISTINCT campaign_id) FROM links) AS campaign_ids,
       (SELECT array_agg(t.id) FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id WHERE ct.contact_id = $1) AS tag_ids,
       (SELECT array_agg(lower(t.name)) FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id WHERE ct.contact_id = $1) AS tag_names`,
    [contact.id]
  );
  const f = r.rows[0]!;

  // Reply text: the reply this event is about, else the newest inbound reply.
  const replyId = numOrNull(event.data?.replyId);
  const textRow = await client.query<{ body_text: string | null; body_html: string | null }>(
    replyId != null
      ? `SELECT body_text, body_html FROM email_replies WHERE id = $2 AND recipient_id IN
           (SELECT recipient_id FROM crm_contact_recipients WHERE contact_id = $1)`
      : `SELECT er.body_text, er.body_html FROM email_replies er
          WHERE er.recipient_id IN (SELECT recipient_id FROM crm_contact_recipients WHERE contact_id = $1)
            AND er.direction = 'inbound'
          ORDER BY er.received_at DESC, er.id DESC LIMIT 1`,
    replyId != null ? [contact.id, replyId] : [contact.id]
  );
  const t = textRow.rows[0];
  const replyText = t ? replyPlainText({ bodyText: t.body_text, bodyHtml: t.body_html }).toLowerCase() : '';

  const eventCampaign = numOrNull(event.data?.campaignId);
  const campaignIds = (f.campaign_ids ?? []).map(Number);
  if (eventCampaign != null && !campaignIds.includes(eventCampaign)) campaignIds.unshift(eventCampaign);

  const eventLabel = typeof event.data?.label === 'string' ? (event.data.label as string) : null;

  return {
    reply_label: eventLabel ?? contact.last_reply_label,
    reply_count: num(f.reply_count),
    open_count: num(contact.open_count),
    follow_up_count: num(f.follow_up_count),
    days_since_last_outbound: numOrNull(f.days_since_last_outbound),
    days_since_last_reply: numOrNull(f.days_since_last_reply),
    days_in_stage: numOrNull(contact.days_in_stage),
    reply_text: replyText,
    tags: [...(f.tag_ids ?? []).map(Number), ...(f.tag_names ?? [])],
    score: num(contact.score),
    campaign_ids: campaignIds,
    current_stage_id: stage?.id ?? null,
    current_stage_name: stage ? stage.name.toLowerCase() : null,
    custom_fields: contact.custom_fields ?? {},
  };
}

function fillMessage(template: string, contact: ContactRow, stage: StageInfo | null): string {
  return template
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name?.trim() || contact.email)
    .replace(/\{\{\s*email\s*\}\}/gi, contact.email)
    .replace(/\{\{\s*stage\s*\}\}/gi, stage?.name ?? '')
    .slice(0, 1000);
}

async function runAction(
  client: PoolClient,
  action: Record<string, unknown>,
  rule: RuleRow,
  contact: ContactRow,
  stage: StageInfo | null,
  event: CrmEvent
): Promise<string> {
  const type = String(action.type ?? '');
  switch (type) {
    case 'add_tag': {
      const r = await client.query(
        `INSERT INTO crm_contact_tags (contact_id, tag_id)
         SELECT $1, t.id FROM crm_tags t WHERE t.id = $2 AND t.user_id = $3
         ON CONFLICT DO NOTHING`,
        [contact.id, num(action.tagId, -1), contact.user_id]
      );
      return r.rowCount ? 'tag added' : 'tag not found or already set';
    }
    case 'remove_tag': {
      const r = await client.query(`DELETE FROM crm_contact_tags WHERE contact_id = $1 AND tag_id = $2`, [contact.id, num(action.tagId, -1)]);
      return r.rowCount ? 'tag removed' : 'tag was not set';
    }
    case 'stop_follow_ups':
      await stopFollowUps(client, contact.id, `rule ${rule.id}`);
      contact.follow_ups_stopped = true;
      return 'follow-ups stopped';
    case 'schedule_follow_up': {
      if (contact.follow_ups_stopped) return 'skipped: follow-ups are stopped for this lead';
      const pending = await client.query(
        `SELECT 1 FROM crm_scheduled_follow_ups WHERE contact_id = $1 AND status IN ('pending', 'sending') LIMIT 1`,
        [contact.id]
      );
      if (pending.rowCount) return 'skipped: a follow-up is already scheduled';
      // Step 9 loop guard: a rule like "follow-up sent → schedule follow-up" must not email a lead forever.
      // Each rule schedules once per stage visit, and a lead gets at most MAX_RULE_FOLLOW_UPS_PER_LEAD in total.
      const used = await client.query<{ this_rule: boolean; total: number }>(
        `SELECT bool_or(f.rule_id = $2 AND f.created_at >= cc.stage_entered_at) AS this_rule,
                count(*)::int AS total
           FROM crm_scheduled_follow_ups f JOIN crm_contacts cc ON cc.id = f.contact_id
          WHERE f.contact_id = $1 AND f.status NOT IN ('cancelled', 'failed')`,
        [contact.id, rule.id]
      );
      if (used.rows[0]?.this_rule) return 'skipped: this rule already scheduled a follow-up while the lead is in this stage';
      if ((used.rows[0]?.total ?? 0) >= MAX_RULE_FOLLOW_UPS_PER_LEAD) {
        return `skipped: this lead already got ${MAX_RULE_FOLLOW_UPS_PER_LEAD} follow-ups from rules`;
      }
      const eventRecipient = numOrNull(event.data?.recipientId);
      const rec = await client.query<{ recipient_id: number; campaign_id: number }>(
        `SELECT x.recipient_id, x.campaign_id
           FROM crm_contact_recipients x JOIN recipients r ON r.id = x.recipient_id
          WHERE x.contact_id = $1 AND r.message_id IS NOT NULL
          ORDER BY (x.recipient_id = $2) DESC, COALESCE(r.sent_ts, r.sent_at::timestamptz) DESC NULLS LAST, x.recipient_id DESC
          LIMIT 1`,
        [contact.id, eventRecipient ?? -1]
      );
      const target = rec.rows[0];
      if (!target) return 'skipped: no sent campaign email to follow up on';
      const days = Math.min(365, Math.max(0, num(action.afterDays, 3)));
      const templateId = action.templateId == null || action.templateId === '' ? null : String(action.templateId).slice(0, 64);
      await client.query(
        `INSERT INTO crm_scheduled_follow_ups (user_id, contact_id, recipient_id, campaign_id, rule_id, template_id, due_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
        [contact.user_id, contact.id, target.recipient_id, target.campaign_id, rule.id, templateId, days * 86400]
      );
      return `follow-up scheduled in ${days} day(s)`;
    }
    case 'notify_user': {
      const message = fillMessage(String(action.message ?? 'Rule "{{stage}}" matched for {{name}}'), contact, stage);
      // time_tick repeats every 30 min: notify once per stage visit (step 9 loop guard).
      if (event.type === 'time_tick') {
        const done = await client.query(
          `SELECT 1 FROM user_notifications n, crm_contacts cc
            WHERE cc.id = $2 AND n.user_id = $1 AND n.type = 'crm_rule'
              AND n.payload->>'contactId' = $2::text AND n.payload->>'ruleId' = $3::text
              AND n.created_at >= cc.stage_entered_at
            LIMIT 1`,
          [contact.user_id, contact.id, rule.id]
        );
        if (done.rowCount) return 'skipped: already notified while the lead is in this stage';
      }
      const recent = await client.query(
        `SELECT 1 FROM user_notifications
          WHERE user_id = $1 AND type = 'crm_rule' AND created_at > now() - make_interval(mins => $4)
            AND payload->>'contactId' = $2::text AND payload->>'ruleId' = $3::text
          LIMIT 1`,
        [contact.user_id, String(contact.id), String(rule.id), NOTIFY_DEDUPE_MINUTES]
      );
      if (recent.rowCount) return 'skipped: same notification sent a few minutes ago';
      await client.query(
        `INSERT INTO user_notifications (user_id, type, payload) VALUES ($1, 'crm_rule', $2::jsonb)`,
        [
          contact.user_id,
          JSON.stringify({
            contactId: contact.id,
            email: contact.email,
            name: contact.name,
            ruleId: rule.id,
            ruleName: rule.name,
            stage: stage?.name ?? null,
            event: event.type,
            message,
          }),
        ]
      );
      return 'notification created';
    }
    case 'add_score': {
      // Step 7: the rule event is part of the score ("Pipeline rules"), then the score is recalculated.
      const points = Math.max(-1000, Math.min(1000, Math.round(num(action.points))));
      if (points === 0) return 'skipped: 0 points';
      if (event.type === 'time_tick') {
        // time_tick repeats every 30 min: add the points once per stage visit (step 9 loop guard).
        const done = await client.query(
          `SELECT 1 FROM crm_score_events e JOIN crm_contacts cc ON cc.id = e.contact_id
            WHERE e.contact_id = $1 AND e.source_type = 'rule' AND e.source_id = $2 AND e.created_at >= cc.stage_entered_at
            LIMIT 1`,
          [contact.id, rule.id]
        );
        if (done.rowCount) return 'skipped: points already added while the lead is in this stage';
      }
      await client.query(
        `INSERT INTO crm_score_events (contact_id, points, reason, source_type, source_id) VALUES ($1, $2, $3, 'rule', $4)`,
        [contact.id, points, `Rule: ${rule.name}`.slice(0, 255), rule.id]
      );
      const s = await recalcContactScore(client, contact.id);
      if (s) contact.score = s.score;
      return `score ${points > 0 ? '+' : ''}${points}`;
    }
    case 'move_to_stage':
      return 'handled separately';
    default:
      return `skipped: unknown action "${type}"`;
  }
}

async function moveContact(client: PoolClient, contact: ContactRow, from: StageInfo | null, to: StageInfo, ruleId: number | null): Promise<void> {
  await client.query(
    `UPDATE crm_contacts SET stage_id = $2, stage_entered_at = now(), updated_at = now() WHERE id = $1`,
    [contact.id, to.id]
  );
  await client.query(
    `INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, rule_id, reason) VALUES ($1, $2, $3, $4, 'rule')`,
    [contact.id, from?.id ?? null, to.id, ruleId]
  );
  if (to.stopFollowUps) {
    await cancelPendingFollowUps(client, contact.id, `entered stage "${to.name}"`);
  }
  contact.stage_id = to.id;
  contact.days_in_stage = 0;
}

function parseActions(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter((a) => a && typeof a === 'object') as Array<Record<string, unknown>>;
  return [];
}

/** Runs the rules for one event inside the given transaction. Exported for tests. */
export async function runRulesForEvent(client: PoolClient, contactId: number, event: CrmEvent): Promise<EngineResult> {
  const result: EngineResult = { moves: [], actions: [] };
  const contact = await lockContact(client, contactId);
  if (!contact) return { ...result, skipped: 'contact not found' };

  if (!(await applyEventToContact(client, contact, event))) return { ...result, skipped: 'duplicate open' };
  // Step 7: score first, so rule conditions on "score" see the new value.
  const scored = await recalcContactScore(client, contact.id);
  if (scored) contact.score = scored.score;
  if (contact.pipeline_id == null) return { ...result, skipped: 'contact has no pipeline' };

  await seedDefaultRules(contact.pipeline_id, client);
  const stages = await loadStages(client, contact.pipeline_id);
  const executed = new Set<number>();

  for (let pass = 0; pass <= MAX_MOVES_PER_EVENT; pass++) {
    const current = contact.stage_id != null ? stages.get(contact.stage_id) ?? null : null;
    const rules = await client.query<RuleRow>(
      `SELECT id, name, priority, from_stage_id, conditions, actions, forward_only
         FROM crm_rules
        WHERE pipeline_id = $1 AND is_active AND trigger = $2 AND (from_stage_id IS NULL OR from_stage_id = $3)
        ORDER BY priority DESC, id ASC`,
      [contact.pipeline_id, event.type, contact.stage_id]
    );
    const candidates = rules.rows.filter((r) => !executed.has(r.id));
    if (candidates.length === 0) break;

    const facts = await loadFacts(client, contact, current, event);
    let moved = false;
    for (const rule of candidates) {
      if (!evaluateConditions(rule.conditions, facts)) continue;
      executed.add(rule.id);
      const actions = parseActions(rule.actions);

      for (const action of actions) {
        if (action.type === 'move_to_stage') continue;
        try {
          result.actions.push({ ruleId: rule.id, type: String(action.type), result: await runAction(client, action, rule, contact, current, event) });
        } catch (err) {
          result.actions.push({ ruleId: rule.id, type: String(action.type), result: `error: ${(err as Error).message}` });
          throw err; // roll back the whole event: half-applied rules are worse than none
        }
      }

      const move = actions.find((a) => a.type === 'move_to_stage');
      if (move && !moved && result.moves.length < MAX_MOVES_PER_EVENT) {
        const target = stages.get(num(move.stageId, -1));
        const check = canAutoMove(current, target, rule.forward_only !== false);
        if (check.ok && target) {
          await moveContact(client, contact, current, target, rule.id);
          result.moves.push({ from: current?.id ?? null, to: target.id, ruleId: rule.id });
          moved = true;
        } else if (!check.ok) {
          result.actions.push({ ruleId: rule.id, type: 'move_to_stage', result: `not moved: ${check.reason}` });
        }
      }
    }
    if (!moved || result.moves.length >= MAX_MOVES_PER_EVENT) break;
  }

  if (event.type === 'bounced' && result.moves.length === 0) {
    const current = contact.stage_id != null ? stages.get(contact.stage_id) ?? null : null;
    if (current?.type !== 'lost') {
      const lostStage = Array.from(stages.values()).find((s) => s.type === 'lost');
      if (lostStage) {
        const check = canAutoMove(current, lostStage, false);
        if (check.ok) {
          await moveContact(client, contact, current, lostStage, null);
          result.moves.push({ from: current?.id ?? null, to: lostStage.id, ruleId: 0 });
        }
      }
    }
  }

  return result;
}

export interface DryRunRuleResult {
  ruleId: number;
  name: string;
  trigger: string;
  priority: number;
  isActive: boolean;
  /** from_stage is empty or the lead's current stage */
  appliesToStage: boolean;
  conditionsMatch: boolean;
  move: { toStageId: number; toStageName: string | null; allowed: boolean; reason: string | null } | null;
  otherActions: string[];
  /** true for the rule that would actually move the lead for its trigger */
  wins: boolean;
}

/**
 * Pipeline Builder "Test" button: which rules would match this lead right now. Reads only, changes nothing.
 * `trigger` limits the check to one trigger; `label` pretends the reply label is this value.
 */
export async function dryRunRules(
  userId: number,
  pipelineId: number,
  contactId: number,
  opts: { trigger?: string | null; label?: string | null } = {}
): Promise<{ contact: { id: number; email: string; name: string | null; stageId: number | null; stageName: string | null }; results: DryRunRuleResult[] } | null> {
  const c = await dbPool.query<ContactRow>(
    `SELECT cc.id, cc.user_id, cc.email, cc.name, cc.pipeline_id, cc.stage_id, cc.score, cc.last_reply_label,
            cc.custom_fields, cc.open_count, cc.follow_ups_stopped,
            EXTRACT(EPOCH FROM (now() - cc.stage_entered_at)) / 86400 AS days_in_stage
       FROM crm_contacts cc
      WHERE cc.id = $1 AND cc.user_id = $2 AND cc.pipeline_id = $3`,
    [contactId, userId, pipelineId]
  );
  const contact = c.rows[0];
  if (!contact) return null;

  const client = await dbPool.connect();
  try {
    const stages = await loadStages(client, pipelineId);
    const current = contact.stage_id != null ? stages.get(contact.stage_id) ?? null : null;
    const event: CrmEvent = { type: (opts.trigger as CrmEvent['type']) || 'manual_move', data: opts.label ? { label: opts.label } : {} };
    const facts = await loadFacts(client, contact, current, event);
    const rules = await client.query<RuleRow & { trigger: string; is_active: boolean }>(
      `SELECT id, name, priority, from_stage_id, conditions, actions, forward_only, trigger, is_active
         FROM crm_rules WHERE pipeline_id = $1 ${opts.trigger ? 'AND trigger = $2' : ''}
        ORDER BY trigger, priority DESC, id ASC`,
      opts.trigger ? [pipelineId, opts.trigger] : [pipelineId]
    );
    const winners = new Set<string>();
    const results = rules.rows.map((rule): DryRunRuleResult => {
      const actions = parseActions(rule.actions);
      const appliesToStage = rule.from_stage_id == null || rule.from_stage_id === contact.stage_id;
      const conditionsMatch = evaluateConditions(rule.conditions, facts);
      const moveAct = actions.find((a) => a.type === 'move_to_stage');
      let move: DryRunRuleResult['move'] = null;
      let wins = false;
      if (moveAct) {
        const target = stages.get(num(moveAct.stageId, -1));
        const check = canAutoMove(current, target, rule.forward_only !== false);
        move = { toStageId: num(moveAct.stageId, -1), toStageName: target?.name ?? null, allowed: check.ok, reason: check.ok ? null : check.reason };
        if (rule.is_active && appliesToStage && conditionsMatch && check.ok && !winners.has(rule.trigger)) {
          winners.add(rule.trigger);
          wins = true;
        }
      }
      return {
        ruleId: rule.id,
        name: rule.name,
        trigger: rule.trigger,
        priority: rule.priority,
        isActive: rule.is_active,
        appliesToStage,
        conditionsMatch,
        move,
        otherActions: actions.filter((a) => a.type !== 'move_to_stage').map((a) => String(a.type)),
        wins,
      };
    });
    return {
      contact: { id: contact.id, email: contact.email, name: contact.name, stageId: contact.stage_id, stageName: current?.name ?? null },
      results,
    };
  } finally {
    client.release();
  }
}

/** Event handler registered in events.ts. Own transaction per event; errors are logged by the caller. */
export async function handleCrmEvent(userId: number, contactId: number, event: CrmEvent): Promise<void> {
  if (process.env.CRM_RULES_DISABLED === 'true') {
    // Rules are off, but the lead score (step 7) still follows events.
    const owner = await dbPool.query<{ user_id: number }>(`SELECT user_id FROM crm_contacts WHERE id = $1`, [contactId]);
    if (owner.rows[0]?.user_id === userId) await recalcContactScore(dbPool, contactId);
    return;
  }
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query<{ user_id: number }>(`SELECT user_id FROM crm_contacts WHERE id = $1`, [contactId]);
    if (owner.rows[0]?.user_id !== userId) {
      await client.query('ROLLBACK');
      return;
    }
    const res = await runRulesForEvent(client, contactId, event);
    await client.query('COMMIT');
    if (res.moves.length > 0 && process.env.CRM_LOG_MOVES !== 'false') {
      console.log(`[crm] contact ${contactId} ${event.type}: moved ${res.moves.map((m) => `${m.from ?? '-'}→${m.to} (rule ${m.ruleId})`).join(', ')}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
