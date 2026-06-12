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
      COUNT(*) FILTER (WHERE delivered_at IS NOT NULL OR status = 'delivered')::int AS "delivered",
      COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS "opened",
      COUNT(*) FILTER (WHERE status = 'failed')::int AS "failed",
      COUNT(*) FILTER (WHERE status = 'bounced')::int AS "bounced",
      COUNT(*) FILTER (WHERE status = 'complained')::int AS "complained",
      COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS "replied"
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
