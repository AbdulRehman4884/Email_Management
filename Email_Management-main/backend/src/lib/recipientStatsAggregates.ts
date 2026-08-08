/**
 * Single source of truth for campaign KPIs from the `recipients` table.
 * Definitions align with:
 * - Follow-up analytics (`primarySent` = sent_at present; `opened` = opened_at present)
 * - `getRecipients` filters in campaignController (`delivered` = delivered_at OR status = 'delivered'; `opened` = opened_at)
 */
import { dbPool } from "./db.js";

export type RecipientDerivedStats = {
  primarySent: number;
  delivered: number;
  opened: number;
  failed: number;
  bounced: number;
  complained: number;
  replied: number;
};

export async function getRecipientDerivedStatsForCampaign(campaignId: number): Promise<RecipientDerivedStats> {
  const { rows } = await dbPool.query(
    `SELECT
      COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS "primarySent",
      COUNT(*) FILTER (
        WHERE (delivered_at IS NOT NULL OR status IN ('delivered', 'sent'))
          AND status NOT IN ('failed', 'bounced', 'complained')
      )::int AS "delivered",
      COUNT(*) FILTER (
        WHERE opened_at IS NOT NULL
          AND status NOT IN ('failed', 'bounced', 'complained')
      )::int AS "opened",
      COUNT(*) FILTER (WHERE status = 'failed')::int AS "failed",
      COUNT(*) FILTER (WHERE status = 'bounced')::int AS "bounced",
      COUNT(*) FILTER (WHERE status = 'complained')::int AS "complained",
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM email_replies er
          WHERE er.recipient_id = recipients.id
            AND er.direction = 'inbound'
            AND NOT (
              LOWER(SPLIT_PART(er.from_email, '@', 1)) = ANY(ARRAY[
                'mailer-daemon', 'postmaster', 'mail-daemon', 'mailerdaemon'
              ])
              OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon%'
              OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'bounce%'
            )
        )
      )::int AS "replied"
    FROM recipients
    WHERE campaign_id = $1`,
    [campaignId]
  );
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) {
    return {
      primarySent: 0,
      delivered: 0,
      opened: 0,
      failed: 0,
      bounced: 0,
      complained: 0,
      replied: 0,
    };
  }
  return {
    primarySent: Number(r.primarySent ?? 0),
    delivered: Number(r.delivered ?? 0),
    opened: Number(r.opened ?? 0),
    failed: Number(r.failed ?? 0),
    bounced: Number(r.bounced ?? 0),
    complained: Number(r.complained ?? 0),
    replied: Number(r.replied ?? 0),
  };
}
