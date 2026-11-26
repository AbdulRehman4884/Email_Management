-- Rollback 0049_automation_smtp_accounts
ALTER TABLE crm_automations DROP COLUMN IF EXISTS smtp_setting_ids;
DELETE FROM _sql_migrations WHERE filename = '0049_automation_smtp_accounts.sql';
