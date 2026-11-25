-- 0048_automation_send_window
-- Give lead automations sending days + a daily time window, like campaigns and follow-up jobs.
-- send_weekdays: ISO weekdays 1–7 (Mon–Sun) when emails may go out; NULL = any day.
-- daily_send_window_start / _end: HH:mm:ss (schedule timezone); both NULL = any time of day.
-- When both are set the automation only sends emails inside [start, end); end < start crosses midnight.
-- An email step due outside the allowed days/hours is held and retried at the next open time
-- (it is not skipped), so a "wait 2 days" that lands on a Sunday sends on the next allowed day.
ALTER TABLE crm_automations
  ADD COLUMN IF NOT EXISTS send_weekdays jsonb,
  ADD COLUMN IF NOT EXISTS daily_send_window_start varchar(8),
  ADD COLUMN IF NOT EXISTS daily_send_window_end varchar(8);
