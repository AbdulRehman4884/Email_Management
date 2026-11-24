-- Rollback 0047_followup_send_window
ALTER TABLE follow_up_jobs DROP COLUMN IF EXISTS daily_send_window_start;
ALTER TABLE follow_up_jobs DROP COLUMN IF EXISTS daily_send_window_end;
DELETE FROM _sql_migrations WHERE filename = '0047_followup_send_window.sql';
