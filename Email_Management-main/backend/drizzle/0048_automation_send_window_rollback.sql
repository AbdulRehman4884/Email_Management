-- Rollback 0048_automation_send_window
ALTER TABLE crm_automations DROP COLUMN IF EXISTS send_weekdays;
ALTER TABLE crm_automations DROP COLUMN IF EXISTS daily_send_window_start;
ALTER TABLE crm_automations DROP COLUMN IF EXISTS daily_send_window_end;
DELETE FROM _sql_migrations WHERE filename = '0048_automation_send_window.sql';
