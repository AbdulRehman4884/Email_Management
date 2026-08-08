-- Align campaign_stats counters with recipients (same definitions as recipientStatsAggregates / getRecipients filters).
-- Run after deploy so dashboard aggregates and DB rows match recipient truth.

UPDATE campaign_stats AS cs
SET
  sent_count = s.primary_sent,
  delivered_count = s.delivered,
  opened_count = s.opened,
  failed_count = s.failed,
  bounced_count = s.bounced,
  complained_count = s.complained,
  replied_count = s.replied
FROM (
  SELECT
    campaign_id,
    COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS primary_sent,
    COUNT(*) FILTER (WHERE delivered_at IS NOT NULL OR status = 'delivered')::int AS delivered,
    COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
    COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounced,
    COUNT(*) FILTER (WHERE status = 'complained')::int AS complained,
    COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
  FROM recipients
  GROUP BY campaign_id
) AS s
WHERE cs.campaign_id = s.campaign_id;
