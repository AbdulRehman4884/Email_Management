/**
 * Find (or create) the CRM contact behind a campaign recipient.
 *
 * Backfill (scripts/crmBackfill.ts) links old recipients. Recipients added after the backfill are
 * linked here the first time something happens to them. A new contact goes into the campaign's
 * pipeline (step 5, "Assign to pipeline") or else the user's default pipeline (created if the user has
 * none), first stage, and that placement is written to crm_stage_history.
 * When a recipient is linked, the campaign's auto tags (step 5) are added to the lead.
 */
import { dbPool } from '../db.js';
import { ensureDefaultPipeline } from './pipelines.js';
import { applyAutoTagsToContact } from './tags.js';

export interface ContactRef {
  contactId: number;
  userId: number;
}

function parseCustomFields(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v != null) out[k] = String(v);
      }
      return JSON.stringify(out);
    }
  } catch {
    // ignore invalid JSON
  }
  return null;
}

export async function ensureContactForRecipient(recipientId: number): Promise<ContactRef | null> {
  const linked = await dbPool.query<{ contact_id: number; user_id: number }>(
    `SELECT ccr.contact_id, cc.user_id
       FROM crm_contact_recipients ccr
       JOIN crm_contacts cc ON cc.id = ccr.contact_id
      WHERE ccr.recipient_id = $1
      LIMIT 1`,
    [recipientId]
  );
  if (linked.rows[0]) return { contactId: linked.rows[0].contact_id, userId: linked.rows[0].user_id };

  const rec = await dbPool.query<{ campaign_id: number; email: string; name: string | null; custom_fields: string | null; user_id: number }>(
    `SELECT r.campaign_id, r.email, r.name, r.custom_fields, c.user_id
       FROM recipients r
       JOIN campaigns c ON c.id = r.campaign_id
      WHERE r.id = $1`,
    [recipientId]
  );
  const r = rec.rows[0];
  if (!r) return null;
  const email = String(r.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 255) return null;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    // One pipeline per new user even if two replies arrive at the same moment.
    await client.query('SELECT pg_advisory_xact_lock(42031, $1)', [r.user_id]);
    await ensureDefaultPipeline(r.user_id, client);

    // The campaign's own pipeline first (step 5), then the default pipeline.
    const pipe = await client.query<{ pipeline_id: number; stage_id: number | null }>(
      `SELECT p.id AS pipeline_id,
              (SELECT s.id FROM crm_pipeline_stages s WHERE s.pipeline_id = p.id
                ORDER BY s.position ASC, s.id ASC LIMIT 1) AS stage_id
         FROM crm_pipelines p
         LEFT JOIN crm_campaign_settings cs ON cs.campaign_id = $2 AND cs.pipeline_id = p.id
        WHERE p.user_id = $1
        ORDER BY (cs.campaign_id IS NOT NULL) DESC, p.is_default DESC, p.id ASC
        LIMIT 1`,
      [r.user_id, r.campaign_id]
    );
    const pipelineId = pipe.rows[0]?.pipeline_id ?? null;
    const stageId = pipe.rows[0]?.stage_id ?? null;

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO crm_contacts (user_id, email, name, custom_fields, pipeline_id, stage_id, stage_entered_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, CASE WHEN $6::int IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (user_id, email) DO NOTHING
       RETURNING id`,
      [r.user_id, email, r.name?.trim()?.slice(0, 255) || null, parseCustomFields(r.custom_fields), pipelineId, stageId]
    );

    let contactId = inserted.rows[0]?.id;
    if (contactId != null && stageId != null) {
      await client.query(
        `INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, reason)
         VALUES ($1, NULL, $2, 'created')`,
        [contactId, stageId]
      );
    }
    if (contactId == null) {
      const existing = await client.query<{ id: number }>(
        `SELECT id FROM crm_contacts WHERE user_id = $1 AND email = $2`,
        [r.user_id, email]
      );
      contactId = existing.rows[0]?.id;
    }
    if (contactId == null) {
      await client.query('ROLLBACK');
      return null;
    }

    const link = await client.query(
      `INSERT INTO crm_contact_recipients (contact_id, recipient_id, campaign_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (recipient_id) DO NOTHING`,
      [contactId, recipientId, r.campaign_id]
    );
    if (link.rowCount) await applyAutoTagsToContact(client, r.campaign_id, contactId);
    await client.query('COMMIT');
    return { contactId, userId: r.user_id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
