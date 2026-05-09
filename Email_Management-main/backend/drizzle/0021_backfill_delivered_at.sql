-- Backfill delivered_at for legacy successful sends (SMTP path did not set it before worker fix).
UPDATE recipients
SET delivered_at = sent_at
WHERE sent_at IS NOT NULL
  AND delivered_at IS NULL
  AND status IN ('sent', 'delivered');
