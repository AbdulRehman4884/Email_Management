/**
 * CRM step 7: lead scoring.
 *
 * A lead's score is calculated from what we know about it, every time something changes:
 *   opens (+5 each, at most +15) · replies (+20 each) · the latest reply label (Interested +40 …)
 *   · follow-ups sent after the last reply (-5 each) · no activity (-10 per full 14 days)
 *   · tags (points per tag) · custom fields (e.g. industry = Real Estate: +10) · "Add score" rule actions.
 * The total is clamped to 0..100. Tier: >= hot threshold -> hot, >= warm threshold -> warm, else cold.
 *
 * The parts are saved on the lead (crm_contacts.score_breakdown, "why this score"), and every part
 * that changes writes a crm_score_events row (the history).
 *
 * Weights live in crm_settings.score_weights (empty = defaults), thresholds in crm_settings.hot_threshold
 * / warm_threshold. Pure parts (normalizeWeights, computeScore, tierFor) are unit tested.
 */
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';
import { nonHumanReplySql } from '../replyLabeling.js';
import { REPLY_LABELS, REPLY_LABEL_META, isReplyLabel, type ReplyLabel } from '../../constants/replyLabels.js';

type Db = Pick<PoolClient, 'query'>;

export interface CustomFieldRule {
  field: string;
  equals: string;
  points: number;
}

export interface ScoreWeights {
  email_opened: number;
  email_opened_max: number;
  reply_received: number;
  labels: Record<ReplyLabel, number>;
  follow_up_no_reply: number;
  inactivity: number;
  inactivity_days: number;
  /** tag id (as text) -> points */
  tags: Record<string, number>;
  custom_fields: CustomFieldRule[];
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  email_opened: 5,
  email_opened_max: 15,
  reply_received: 20,
  labels: {
    interested: 40,
    question: 25,
    meeting_booked: 50,
    out_of_office: 0,
    neutral: 5,
    not_interested: -50,
    bounce_unsubscribe: -100,
  },
  follow_up_no_reply: -5,
  inactivity: -10,
  inactivity_days: 14,
  tags: {},
  custom_fields: [],
};

export const DEFAULT_HOT = 70;
export const DEFAULT_WARM = 40;
export const MAX_TAG_WEIGHTS = 100;
export const MAX_FIELD_RULES = 30;

export type ScoreTier = 'hot' | 'warm' | 'cold';

export interface BreakdownItem {
  /** Stable id of the part: opens, replies, label, follow_ups, inactivity, tag:<id>, field:<n>, rules */
  key: string;
  /** crm_score_events.source_type */
  source: 'open' | 'reply' | 'label' | 'follow_up' | 'decay' | 'tag' | 'custom_field' | 'rule';
  label: string;
  points: number;
}

export interface ScoreFacts {
  openCount: number;
  replyCount: number;
  lastLabel: string | null;
  followUpsSinceReply: number;
  /** Days since the last open, reply or email. */
  daysInactive: number;
  tags: Array<{ id: number; name: string }>;
  customFields: Record<string, unknown> | null;
  /** Sum of "Add score" rule actions. */
  rulePoints: number;
}

const clampInt = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
};

/**
 * Weights from the database or the API, merged over the defaults.
 * `strict`: return errors for bad values (API); otherwise bad values fall back to the default (stored data).
 */
export function normalizeWeights(raw: unknown, strict = false): { weights: ScoreWeights; errors: string[] } {
  const errors: string[] = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const w: ScoreWeights = JSON.parse(JSON.stringify(DEFAULT_WEIGHTS));

  const num = (key: string, label: string, min: number, max: number, set: (n: number) => void) => {
    if (!(key in src) || src[key] === null || src[key] === '') return;
    const n = Number(src[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${label}: a whole number from ${min} to ${max}`);
      return;
    }
    set(n);
  };
  num('email_opened', 'Email opened', -100, 100, (n) => (w.email_opened = n));
  num('email_opened_max', 'Most points from opens', 0, 100, (n) => (w.email_opened_max = n));
  num('reply_received', 'Reply received', -100, 100, (n) => (w.reply_received = n));
  num('follow_up_no_reply', 'Follow-up with no reply', -100, 100, (n) => (w.follow_up_no_reply = n));
  num('inactivity', 'No activity', -100, 100, (n) => (w.inactivity = n));
  num('inactivity_days', 'No activity period (days)', 1, 365, (n) => (w.inactivity_days = n));

  if (src.labels && typeof src.labels === 'object' && !Array.isArray(src.labels)) {
    const labels = src.labels as Record<string, unknown>;
    for (const l of REPLY_LABELS) {
      if (!(l in labels) || labels[l] === null || labels[l] === '') continue;
      const n = Number(labels[l]);
      if (!Number.isInteger(n) || n < -100 || n > 100) errors.push(`${REPLY_LABEL_META[l].name}: a whole number from -100 to 100`);
      else w.labels[l] = n;
    }
  }

  if (src.tags && typeof src.tags === 'object' && !Array.isArray(src.tags)) {
    const entries = Object.entries(src.tags as Record<string, unknown>);
    if (entries.length > MAX_TAG_WEIGHTS) errors.push(`Tags: at most ${MAX_TAG_WEIGHTS}`);
    for (const [id, v] of entries.slice(0, MAX_TAG_WEIGHTS)) {
      const n = Number(v);
      if (!/^\d+$/.test(id)) {
        errors.push(`Tags: "${id}" is not a tag id`);
        continue;
      }
      if (!Number.isInteger(n) || n < -100 || n > 100) {
        errors.push('Tag points: a whole number from -100 to 100');
        continue;
      }
      if (n !== 0) w.tags[id] = n;
    }
  }

  if (Array.isArray(src.custom_fields)) {
    if (src.custom_fields.length > MAX_FIELD_RULES) errors.push(`Custom field rules: at most ${MAX_FIELD_RULES}`);
    src.custom_fields.slice(0, MAX_FIELD_RULES).forEach((r, i) => {
      const rule = (r ?? {}) as Record<string, unknown>;
      const field = String(rule.field ?? '').trim();
      const equals = String(rule.equals ?? '').trim();
      const points = Number(rule.points);
      if (!field || field.length > 64) errors.push(`Custom field rule ${i + 1}: field name is required (at most 64 characters)`);
      else if (!equals || equals.length > 200) errors.push(`Custom field rule ${i + 1}: the value is required (at most 200 characters)`);
      else if (!Number.isInteger(points) || points < -100 || points > 100) errors.push(`Custom field rule ${i + 1}: points must be a whole number from -100 to 100`);
      else w.custom_fields.push({ field, equals, points });
    });
  }

  return { weights: w, errors: strict ? errors : [] };
}

export function tierFor(score: number, hot = DEFAULT_HOT, warm = DEFAULT_WARM): ScoreTier {
  if (score >= hot) return 'hot';
  if (score >= warm) return 'warm';
  return 'cold';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function customFieldValue(fields: Record<string, unknown> | null, name: string): string | null {
  if (!fields) return null;
  const key = Object.keys(fields).find((k) => k.trim().toLowerCase() === name.trim().toLowerCase());
  if (key == null || fields[key] == null) return null;
  return String(fields[key]).trim();
}

/** The score of one lead. Pure: same facts + weights -> same result. */
export function computeScore(
  facts: ScoreFacts,
  weights: ScoreWeights,
  thresholds: { hot: number; warm: number } = { hot: DEFAULT_HOT, warm: DEFAULT_WARM }
): { score: number; tier: ScoreTier; raw: number; breakdown: BreakdownItem[] } {
  const items: BreakdownItem[] = [];
  const add = (item: BreakdownItem) => {
    if (item.points !== 0) items.push(item);
  };

  if (facts.openCount > 0) {
    let pts = facts.openCount * weights.email_opened;
    if (weights.email_opened > 0) pts = Math.min(pts, weights.email_opened_max);
    add({ key: 'opens', source: 'open', label: `Opened ${plural(facts.openCount, 'email', 'emails')}`, points: pts });
  }
  if (facts.replyCount > 0) {
    add({ key: 'replies', source: 'reply', label: plural(facts.replyCount, 'reply', 'replies'), points: facts.replyCount * weights.reply_received });
  }
  if (isReplyLabel(facts.lastLabel)) {
    add({ key: 'label', source: 'label', label: `Latest reply: ${REPLY_LABEL_META[facts.lastLabel].name}`, points: weights.labels[facts.lastLabel] ?? 0 });
  }
  if (facts.followUpsSinceReply > 0) {
    add({
      key: 'follow_ups',
      source: 'follow_up',
      label: `${plural(facts.followUpsSinceReply, 'follow-up', 'follow-ups')} with no reply`,
      points: facts.followUpsSinceReply * weights.follow_up_no_reply,
    });
  }
  const periods = Math.floor(Math.max(0, facts.daysInactive) / weights.inactivity_days);
  if (periods > 0) {
    add({ key: 'inactivity', source: 'decay', label: `No activity for ${Math.floor(facts.daysInactive)} days`, points: periods * weights.inactivity });
  }
  for (const t of facts.tags) {
    const pts = weights.tags[String(t.id)];
    if (pts) add({ key: `tag:${t.id}`, source: 'tag', label: `Tag: ${t.name}`, points: pts });
  }
  weights.custom_fields.forEach((r, i) => {
    const v = customFieldValue(facts.customFields, r.field);
    if (v != null && v.toLowerCase() === r.equals.toLowerCase()) {
      add({ key: `field:${i}:${r.field.toLowerCase()}=${r.equals.toLowerCase()}`, source: 'custom_field', label: `${r.field} = ${r.equals}`, points: r.points });
    }
  });
  if (facts.rulePoints !== 0) add({ key: 'rules', source: 'rule', label: 'Pipeline rules (Add score)', points: facts.rulePoints });

  const raw = items.reduce((s, i) => s + i.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, tier: tierFor(score, thresholds.hot, thresholds.warm), raw, breakdown: items };
}

/**
 * Score events for what changed between the old and the new parts.
 * Rule parts are skipped: the "Add score" action writes its own event.
 */
export function diffBreakdown(oldItems: BreakdownItem[] | null, newItems: BreakdownItem[]): Array<{ points: number; reason: string; source: string }> {
  const before = new Map((oldItems ?? []).map((i) => [i.key, i]));
  const after = new Map(newItems.map((i) => [i.key, i]));
  const out: Array<{ points: number; reason: string; source: string }> = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key);
    const b = after.get(key);
    if ((b ?? a)?.source === 'rule') continue;
    const delta = (b?.points ?? 0) - (a?.points ?? 0);
    if (delta === 0) continue;
    const reason = b ? (a ? `${b.label} (was ${a.points > 0 ? '+' : ''}${a.points})` : b.label) : `No longer: ${a!.label}`;
    out.push({ points: delta, reason: reason.slice(0, 255), source: (b ?? a)!.source });
  }
  return out;
}

export interface ScoringSettings {
  weights: ScoreWeights;
  hot: number;
  warm: number;
}

export async function loadScoringSettings(db: Db, userId: number): Promise<ScoringSettings> {
  const r = await db.query<{ score_weights: unknown; hot_threshold: number | null; warm_threshold: number | null }>(
    `SELECT score_weights, hot_threshold, warm_threshold FROM crm_settings WHERE user_id = $1`,
    [userId]
  );
  const row = r.rows[0];
  return {
    weights: normalizeWeights(row?.score_weights).weights,
    hot: row?.hot_threshold ?? DEFAULT_HOT,
    warm: row?.warm_threshold ?? DEFAULT_WARM,
  };
}

type FactsRow = {
  id: number; user_id: number; open_count: number; last_reply_label: string | null; custom_fields: Record<string, unknown> | null;
  score: number; score_tier: string; score_breakdown: BreakdownItem[] | null; reply_count: number; follow_ups: number;
  days_inactive: number | string | null; tags: Array<{ id: number; name: string }> | null; rule_points: number | string | null;
};

/** Everything the score needs, for many leads at once. */
async function loadFacts(db: Db, contactIds: number[]): Promise<FactsRow[]> {
  const human = `i.direction = 'inbound' AND NOT ${nonHumanReplySql('i')} AND (i.label IS NULL OR i.label NOT IN ('out_of_office', 'bounce_unsubscribe'))`;
  const r = await db.query<FactsRow>(
    `SELECT cc.id, cc.user_id, cc.open_count, cc.last_reply_label, cc.custom_fields, cc.score, cc.score_tier, cc.score_breakdown,
            COALESCE(rp.reply_count, 0)::int AS reply_count,
            (SELECT count(*)::int
               FROM crm_contact_recipients ox JOIN email_replies o ON o.recipient_id = ox.recipient_id
              WHERE ox.contact_id = cc.id AND o.direction = 'outbound'
                AND (o.follow_up_template_id IS NOT NULL OR o.follow_up_job_id IS NOT NULL)
                AND (rp.last_reply IS NULL OR o.received_at > rp.last_reply)) AS follow_ups,
            EXTRACT(EPOCH FROM (now() - GREATEST(cc.last_inbound_at, cc.last_outbound_at, cc.last_opened_at, cc.created_at))) / 86400 AS days_inactive,
            (SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.id)
               FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id WHERE ct.contact_id = cc.id) AS tags,
            (SELECT COALESCE(sum(e.points), 0) FROM crm_score_events e WHERE e.contact_id = cc.id AND e.source_type = 'rule') AS rule_points
       FROM crm_contacts cc
       LEFT JOIN LATERAL (
         SELECT count(*) AS reply_count, max(i.received_at) AS last_reply
           FROM crm_contact_recipients x JOIN email_replies i ON i.recipient_id = x.recipient_id
          WHERE x.contact_id = cc.id AND ${human}) rp ON true
      WHERE cc.id = ANY($1::int[])`,
    [contactIds]
  );
  return r.rows;
}

function factsOf(row: FactsRow): ScoreFacts {
  return {
    openCount: Number(row.open_count) || 0,
    replyCount: Number(row.reply_count) || 0,
    lastLabel: row.last_reply_label,
    followUpsSinceReply: Number(row.follow_ups) || 0,
    daysInactive: Math.max(0, Number(row.days_inactive) || 0),
    tags: row.tags ?? [],
    customFields: row.custom_fields,
    rulePoints: Number(row.rule_points) || 0,
  };
}

/**
 * Recalculates and saves the score of some leads. Writes a score event for every part that changed.
 * Returns the new scores. Safe inside a transaction (pass the client).
 */
export async function recalcScores(db: Db, contactIds: number[]): Promise<Map<number, { score: number; tier: ScoreTier; changed: boolean }>> {
  const out = new Map<number, { score: number; tier: ScoreTier; changed: boolean }>();
  if (contactIds.length === 0) return out;
  const rows = await loadFacts(db, contactIds);
  const settingsByUser = new Map<number, ScoringSettings>();
  for (const row of rows) {
    let settings = settingsByUser.get(row.user_id);
    if (!settings) {
      settings = await loadScoringSettings(db, row.user_id);
      settingsByUser.set(row.user_id, settings);
    }
    const result = computeScore(factsOf(row), settings.weights, settings);
    const events = diffBreakdown(row.score_breakdown, result.breakdown);
    const changed = result.score !== row.score || result.tier !== row.score_tier;
    await db.query(
      `UPDATE crm_contacts
          SET score = $2, score_tier = $3, score_breakdown = $4::jsonb, score_updated_at = now(),
              updated_at = CASE WHEN score <> $2 THEN now() ELSE updated_at END
        WHERE id = $1`,
      [row.id, result.score, result.tier, JSON.stringify(result.breakdown)]
    );
    for (const e of events) {
      await db.query(`INSERT INTO crm_score_events (contact_id, points, reason, source_type) VALUES ($1, $2, $3, $4)`, [row.id, e.points, e.reason, e.source]);
    }
    out.set(row.id, { score: result.score, tier: result.tier, changed });
  }
  return out;
}

export async function recalcContactScore(db: Db, contactId: number): Promise<{ score: number; tier: ScoreTier; changed: boolean } | null> {
  return (await recalcScores(db, [contactId])).get(contactId) ?? null;
}

/** Never throws: for call sites where the score is a side effect (tag changes). */
export async function recalcScoresQuietly(contactIds: number[]): Promise<void> {
  try {
    for (let i = 0; i < contactIds.length; i += 200) await recalcScores(dbPool, contactIds.slice(i, i + 200));
  } catch (err) {
    console.error('[crm] score recalculation failed:', err);
  }
}

/**
 * Worker job: recalculates the scores that are oldest first (never calculated, or older than `staleHours`),
 * so "no activity for 14 days" is applied even when nothing happens to a lead.
 */
export async function recalcStaleScores(opts: { staleHours?: number; limit?: number } = {}): Promise<number> {
  const staleHours = opts.staleHours ?? 12;
  const limit = opts.limit ?? 1000;
  const r = await dbPool.query<{ id: number }>(
    `SELECT id FROM crm_contacts
      WHERE score_updated_at IS NULL OR score_updated_at < now() - make_interval(hours => $1)
      ORDER BY score_updated_at ASC NULLS FIRST, id ASC
      LIMIT $2`,
    [staleHours, limit]
  );
  const ids = r.rows.map((x) => x.id);
  for (let i = 0; i < ids.length; i += 200) await recalcScores(dbPool, ids.slice(i, i + 200));
  return ids.length;
}

// ─── "Recalculate all" for one user (after the weights change), in batches, in the background ───

export interface RecalcJob {
  userId: number;
  total: number;
  done: number;
  changed: number;
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

const jobs = new Map<number, RecalcJob>();

export function getRecalcJob(userId: number): RecalcJob | null {
  return jobs.get(userId) ?? null;
}

/** Starts (or returns the running) recalculation of all the user's leads. Batches of `batchSize`. */
export async function startRecalcJob(userId: number, batchSize = 200): Promise<RecalcJob> {
  const running = jobs.get(userId);
  if (running?.running) return running;
  const ids = (await dbPool.query<{ id: number }>(`SELECT id FROM crm_contacts WHERE user_id = $1 ORDER BY id`, [userId])).rows.map((r) => r.id);
  const job: RecalcJob = {
    userId,
    total: ids.length,
    done: 0,
    changed: 0,
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  jobs.set(userId, job);
  void (async () => {
    try {
      for (let i = 0; i < ids.length; i += batchSize) {
        const res = await recalcScores(dbPool, ids.slice(i, i + batchSize));
        job.done += res.size;
        for (const v of res.values()) if (v.changed) job.changed++;
        await new Promise((r) => setImmediate(r)); // let other requests run between batches
      }
    } catch (err) {
      job.error = (err as Error)?.message ?? 'Recalculation failed';
      console.error('[crm] score recalculation job failed:', err);
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    }
  })();
  return job;
}
