/**
 * CRM step 1 backfill. Run AFTER scripts/run-crm-migration.ts.
 *
 *   npx tsx scripts/crmBackfill.ts
 *
 * For every user it:
 *   1. creates a crm_settings row with defaults,
 *   2. creates a default "Sales Pipeline" with 8 stages (only if the user has no pipeline yet),
 *   3. creates one crm_contact per (user, lowercase email) from existing campaign recipients,
 *   4. links every recipient row to its contact (crm_contact_recipients),
 *   5. places NEW contacts in a starting stage and gives them an initial score,
 *      recording why in crm_stage_history and crm_score_events.
 *
 * Idempotent: running it again only adds what is missing. Existing contacts are never
 * moved, re-scored or overwritten. Only crm_* tables are written; existing tables are read only.
 * Old replies do NOT mark contacts as "needs reply".
 */
import 'dotenv/config';
import type { PoolClient } from 'pg';
import { dbPool } from '../src/lib/db.js';
import { relabelUnlabeledReplies } from '../src/lib/crm/labelReply.js';

const BATCH_SIZE = 1000;

type StageKey = 'new' | 'contacted' | 'engaged' | 'replied' | 'interested' | 'meeting' | 'won' | 'lost';

const DEFAULT_STAGES: Array<{ key: StageKey; name: string; color: string; type: 'normal' | 'won' | 'lost'; stopFollowUps: boolean }> = [
  { key: 'new', name: 'New Lead', color: '#94a3b8', type: 'normal', stopFollowUps: false },
  { key: 'contacted', name: 'Contacted', color: '#38bdf8', type: 'normal', stopFollowUps: false },
  { key: 'engaged', name: 'Engaged', color: '#818cf8', type: 'normal', stopFollowUps: false },
  { key: 'replied', name: 'Replied', color: '#a855f7', type: 'normal', stopFollowUps: false },
  { key: 'interested', name: 'Interested', color: '#22c55e', type: 'normal', stopFollowUps: true },
  { key: 'meeting', name: 'Meeting Booked', color: '#f59e0b', type: 'normal', stopFollowUps: true },
  { key: 'won', name: 'Won', color: '#16a34a', type: 'won', stopFollowUps: true },
  { key: 'lost', name: 'Lost', color: '#ef4444', type: 'lost', stopFollowUps: true },
];

/** Starting points for backfilled contacts (the scoring engine in step 7 uses crm_settings.score_weights). */
const BACKFILL_POINTS = { opened: 5, replied: 20 };
const DEFAULT_HOT = 70;
const DEFAULT_WARM = 40;

interface RecipientRow {
  id: number;
  campaign_id: number;
  email: string;
  name: string | null;
  custom_fields: string | null;
  status: string;
  sent: boolean;
  opened: boolean;
  replied: boolean;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
}

interface ContactDraft {
  email: string;
  name: string | null;
  company: string | null;
  customFields: Record<string, string> | null;
  stageKey: StageKey;
  score: number;
  opened: boolean;
  replied: boolean;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  recipients: Array<{ id: number; campaignId: number }>;
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function parseCustomFields(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v != null) out[k] = String(v);
      }
      return out;
    }
  } catch {
    // ignore invalid JSON
  }
  return null;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function tierFor(score: number): 'hot' | 'warm' | 'cold' {
  if (score >= DEFAULT_HOT) return 'hot';
  if (score >= DEFAULT_WARM) return 'warm';
  return 'cold';
}

function buildDrafts(rows: RecipientRow[]): ContactDraft[] {
  const byEmail = new Map<string, RecipientRow[]>();
  for (const row of rows) {
    const email = normalizeEmail(row.email ?? '');
    if (!email || !email.includes('@') || email.length > 255) continue;
    const list = byEmail.get(email);
    if (list) list.push(row);
    else byEmail.set(email, [row]);
  }

  const drafts: ContactDraft[] = [];
  for (const [email, items] of byEmail) {
    const replied = items.some((i) => i.replied);
    const opened = items.some((i) => i.opened);
    const sent = items.some((i) => i.sent);
    const allBounced = items.every((i) => i.status === 'bounced' || i.status === 'complained');

    let stageKey: StageKey = 'new';
    if (replied) stageKey = 'replied';
    else if (allBounced) stageKey = 'lost';
    else if (opened) stageKey = 'engaged';
    else if (sent) stageKey = 'contacted';

    let customFields: Record<string, string> | null = null;
    let lastInboundAt: string | null = null;
    let lastOutboundAt: string | null = null;
    for (const item of items) {
      const cf = parseCustomFields(item.custom_fields);
      if (cf) customFields = { ...(customFields ?? {}), ...cf };
      lastInboundAt = maxIso(lastInboundAt, item.last_inbound_at);
      lastOutboundAt = maxIso(lastOutboundAt, item.last_outbound_at);
    }

    let name = items.map((i) => i.name?.trim()).find((n) => n) ?? null;
    if (!name && customFields) {
      const first = (customFields['first_name'] || customFields['firstname'] || customFields['first'] || '').trim();
      const last = (customFields['last_name'] || customFields['lastname'] || customFields['last'] || '').trim();
      name = [first, last].filter(Boolean).join(' ') || customFields['name'] || null;
    }
    const company = (customFields?.['company'] || customFields?.['Company'] || customFields?.['organization'] || null)?.trim()?.slice(0, 255) || null;
    const score = (opened ? BACKFILL_POINTS.opened : 0) + (replied ? BACKFILL_POINTS.replied : 0);

    drafts.push({
      email,
      name: name ? name.slice(0, 255) : null,
      company,
      customFields,
      stageKey,
      score,
      opened,
      replied,
      lastInboundAt,
      lastOutboundAt,
      recipients: items.map((i) => ({ id: i.id, campaignId: i.campaign_id })),
    });
  }
  return drafts;
}

async function ensureSettingsAndPipeline(
  client: PoolClient,
  userId: number
): Promise<{ pipelineId: number; stageMap: Map<StageKey, number>; fallbackStageId: number | null }> {
  await client.query(`INSERT INTO crm_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);

  const existing = await client.query<{ id: number }>(
    `SELECT id FROM crm_pipelines WHERE user_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1`,
    [userId]
  );
  let pipelineId = existing.rows[0]?.id;
  if (pipelineId == null) {
    const created = await client.query<{ id: number }>(
      `INSERT INTO crm_pipelines (user_id, name, is_default) VALUES ($1, 'Sales Pipeline', true) RETURNING id`,
      [userId]
    );
    pipelineId = created.rows[0]!.id;
  }

  // Seed stages only into an empty pipeline, so stages a user later deletes are not re-created.
  const stageCount = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM crm_pipeline_stages WHERE pipeline_id = $1`,
    [pipelineId]
  );
  if ((stageCount.rows[0]?.c ?? 0) === 0) {
    for (const [position, st] of DEFAULT_STAGES.entries()) {
      await client.query(
        `INSERT INTO crm_pipeline_stages (pipeline_id, user_id, name, color, position, type, stop_follow_ups)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pipeline_id, name) DO NOTHING`,
        [pipelineId, userId, st.name, st.color, position, st.type, st.stopFollowUps]
      );
    }
  }

  const stages = await client.query<{ id: number; name: string }>(
    `SELECT id, name FROM crm_pipeline_stages WHERE pipeline_id = $1`,
    [pipelineId]
  );
  const byName = new Map(stages.rows.map((s) => [s.name, s.id]));
  const stageMap = new Map<StageKey, number>();
  for (const st of DEFAULT_STAGES) {
    const id = byName.get(st.name);
    if (id != null) stageMap.set(st.key, id);
  }
  // If the user already had their own pipeline with different stage names, fall back to its first stage.
  const first = await client.query<{ id: number }>(
    `SELECT id FROM crm_pipeline_stages WHERE pipeline_id = $1 ORDER BY position ASC, id ASC LIMIT 1`,
    [pipelineId]
  );
  return { pipelineId, stageMap, fallbackStageId: first.rows[0]?.id ?? null };
}

async function backfillUser(client: PoolClient, userId: number) {
  const { pipelineId, stageMap, fallbackStageId } = await ensureSettingsAndPipeline(client, userId);
  const stageIdFor = (key: StageKey): number | null => stageMap.get(key) ?? stageMap.get('new') ?? fallbackStageId;

  const recipients = await client.query<RecipientRow>(
    `SELECT r.id, r.campaign_id, r.email, r.name, r.custom_fields, r.status,
            (r.sent_at IS NOT NULL OR r.sent_ts IS NOT NULL) AS sent,
            (r.opened_at IS NOT NULL) AS opened,
            (r.replied_at IS NOT NULL OR EXISTS (
               SELECT 1 FROM email_replies er WHERE er.recipient_id = r.id AND er.direction = 'inbound'
            )) AS replied,
            COALESCE(r.sent_ts::text, r.sent_at::text) AS last_outbound_at,
            (SELECT max(er.received_at)::text FROM email_replies er
              WHERE er.recipient_id = r.id AND er.direction = 'inbound') AS last_inbound_at
       FROM recipients r
       JOIN campaigns c ON c.id = r.campaign_id
      WHERE c.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM crm_contact_recipients ccr WHERE ccr.recipient_id = r.id)
      ORDER BY r.id ASC`,
    [userId]
  );

  const drafts = buildDrafts(recipients.rows);
  let created = 0;
  let linked = 0;

  for (let i = 0; i < drafts.length; i += BATCH_SIZE) {
    const batch = drafts.slice(i, i + BATCH_SIZE);

    // Insert contacts that do not exist yet; RETURNING gives only the newly created ones.
    const inserted = await client.query<{ id: number; email: string }>(
      `INSERT INTO crm_contacts
         (user_id, email, name, company, custom_fields, pipeline_id, stage_id, stage_entered_at,
          score, score_tier, last_inbound_at, last_outbound_at)
       SELECT $1, d.email, d.name, d.company, d.custom_fields::jsonb, $2, d.stage_id, now(),
              d.score, d.score_tier, d.last_inbound_at::timestamptz, d.last_outbound_at::timestamptz
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::text[], $10::text[], $11::text[])
           AS d(email, name, company, custom_fields, stage_id, score, score_tier, last_inbound_at, last_outbound_at)
       ON CONFLICT (user_id, email) DO NOTHING
       RETURNING id, email`,
      [
        userId,
        pipelineId,
        batch.map((d) => d.email),
        batch.map((d) => d.name),
        batch.map((d) => d.company),
        batch.map((d) => (d.customFields ? JSON.stringify(d.customFields) : null)),
        batch.map((d) => stageIdFor(d.stageKey)),
        batch.map((d) => d.score),
        batch.map((d) => tierFor(d.score)),
        batch.map((d) => d.lastInboundAt),
        batch.map((d) => d.lastOutboundAt),
      ]
    );
    created += inserted.rows.length;
    const newIds = new Map(inserted.rows.map((r) => [r.email, r.id]));

    // CRM-02: a lead that already existed only gets an EMPTY name / company filled (never overwritten).
    await client.query(
      `UPDATE crm_contacts cc
          SET name = COALESCE(NULLIF(btrim(cc.name), ''), d.name),
              company = COALESCE(NULLIF(btrim(cc.company), ''), d.company),
              updated_at = now()
         FROM unnest($2::text[], $3::text[], $4::text[]) AS d(email, name, company)
        WHERE cc.user_id = $1 AND cc.email = d.email
          AND ((NULLIF(btrim(cc.name), '') IS NULL AND d.name IS NOT NULL)
            OR (NULLIF(btrim(cc.company), '') IS NULL AND d.company IS NOT NULL))`,
      [userId, batch.map((d) => d.email), batch.map((d) => d.name), batch.map((d) => d.company)]
    );

    // Resolve ids for every email in the batch (new + already existing contacts).
    const all = await client.query<{ id: number; email: string }>(
      `SELECT id, email FROM crm_contacts WHERE user_id = $1 AND email = ANY($2::text[])`,
      [userId, batch.map((d) => d.email)]
    );
    const idByEmail = new Map(all.rows.map((r) => [r.email, r.id]));

    // Link recipient rows to contacts.
    const linkContact: number[] = [];
    const linkRecipient: number[] = [];
    const linkCampaign: number[] = [];
    for (const d of batch) {
      const contactId = idByEmail.get(d.email);
      if (contactId == null) continue;
      for (const r of d.recipients) {
        linkContact.push(contactId);
        linkRecipient.push(r.id);
        linkCampaign.push(r.campaignId);
      }
    }
    const links = await client.query(
      `INSERT INTO crm_contact_recipients (contact_id, recipient_id, campaign_id)
       SELECT * FROM unnest($1::int[], $2::int[], $3::int[])
       ON CONFLICT (recipient_id) DO NOTHING`,
      [linkContact, linkRecipient, linkCampaign]
    );
    linked += links.rowCount ?? 0;

    // History + score explanation, only for contacts created in this run (keeps re-runs duplicate-free).
    const hContact: number[] = [];
    const hStage: Array<number | null> = [];
    const sContact: number[] = [];
    const sPoints: number[] = [];
    const sReason: string[] = [];
    for (const d of batch) {
      const contactId = newIds.get(d.email);
      if (contactId == null) continue;
      hContact.push(contactId);
      hStage.push(stageIdFor(d.stageKey));
      if (d.opened) {
        sContact.push(contactId);
        sPoints.push(BACKFILL_POINTS.opened);
        sReason.push('Backfill: opened an email');
      }
      if (d.replied) {
        sContact.push(contactId);
        sPoints.push(BACKFILL_POINTS.replied);
        sReason.push('Backfill: replied');
      }
    }
    if (hContact.length > 0) {
      await client.query(
        `INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, reason)
         SELECT c, NULL, s, 'backfill' FROM unnest($1::int[], $2::int[]) AS t(c, s)`,
        [hContact, hStage]
      );
    }
    if (sContact.length > 0) {
      await client.query(
        `INSERT INTO crm_score_events (contact_id, points, reason, source_type)
         SELECT c, p, r, 'backfill' FROM unnest($1::int[], $2::int[], $3::text[]) AS t(c, p, r)`,
        [sContact, sPoints, sReason]
      );
    }
  }

  return { recipients: recipients.rows.length, contacts: drafts.length, created, linked };
}

/**
 * CRM-02: leads created before this fix (also already linked ones) get an EMPTY name / company
 * from their CSV columns: first_name + last_name, company / company_name / organization.
 */
async function fillNameCompanyFromCsv(client: PoolClient, userId: number): Promise<number> {
  const r = await client.query(
    `UPDATE crm_contacts
        SET name = COALESCE(NULLIF(btrim(name), ''),
                     left(NULLIF(btrim(concat_ws(' ', NULLIF(btrim(custom_fields->>'first_name'), ''),
                                                      NULLIF(btrim(custom_fields->>'last_name'), ''))), ''), 255)),
            company = COALESCE(NULLIF(btrim(company), ''),
                     left(NULLIF(btrim(COALESCE(NULLIF(btrim(custom_fields->>'company'), ''),
                                                NULLIF(btrim(custom_fields->>'company_name'), ''),
                                                custom_fields->>'organization')), ''), 255)),
            updated_at = now()
      WHERE user_id = $1 AND custom_fields IS NOT NULL
        AND ((NULLIF(btrim(name), '') IS NULL AND (NULLIF(btrim(custom_fields->>'first_name'), '') IS NOT NULL
                                                   OR NULLIF(btrim(custom_fields->>'last_name'), '') IS NOT NULL))
          OR (NULLIF(btrim(company), '') IS NULL AND (NULLIF(btrim(custom_fields->>'company'), '') IS NOT NULL
                                                   OR NULLIF(btrim(custom_fields->>'company_name'), '') IS NOT NULL
                                                   OR NULLIF(btrim(custom_fields->>'organization'), '') IS NOT NULL)))`,
    [userId]
  );
  return r.rowCount ?? 0;
}

export async function runCrmBackfill() {
  const client = await dbPool.connect();
  try {
    const users = await client.query<{ id: number; email: string }>(`SELECT id, email FROM users ORDER BY id ASC`);
    console.log(`CRM backfill: ${users.rows.length} user(s)`);

    for (const user of users.rows) {
      // One transaction per user: a failure rolls back only that user's CRM rows.
      await client.query('BEGIN');
      try {
        const res = await backfillUser(client, user.id);
        const named = await fillNameCompanyFromCsv(client, user.id);
        await client.query('COMMIT');
        // After COMMIT: labeling uses its own database connections and must see the new leads
        // (inside the open transaction it waited for this transaction forever).
        const relabeled = await relabelUnlabeledReplies(user.id);
        console.log(
          `  user #${user.id}: ${res.recipients} unlinked recipient row(s) -> ${res.contacts} contact(s), ` +
            `${res.created} new, ${res.linked} recipient link(s) added, ${named} name/company filled, ` +
            `${relabeled.processed} replies relabeled`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('CRM backfill finished.');
  } finally {
    client.release();
  }
}

runCrmBackfill()
  .then(() => dbPool.end())
  .catch(async (err) => {
    console.error('CRM backfill failed:', err);
    await dbPool.end();
    process.exitCode = 1;
  });
