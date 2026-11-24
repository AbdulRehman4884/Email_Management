-- 0044_followup_send_window
-- Give follow-up jobs the same daily time window the campaign scheduler already has.
-- Both NULL = send at any time of day (the existing behaviour). When both are set (HH:mm:ss,
-- schedule timezone), the worker only sends inside [start, end); end < start crosses midnight.
ALTER TABLE follow_up_jobs
  ADD COLUMN IF NOT EXISTS daily_send_window_start varchar(8),
  ADD COLUMN IF NOT EXISTS daily_send_window_end varchar(8);
