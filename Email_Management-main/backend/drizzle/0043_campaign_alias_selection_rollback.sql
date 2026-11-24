-- Rollback 0043_campaign_alias_selection
ALTER TABLE campaigns DROP COLUMN IF EXISTS alias_ids;
DELETE FROM _sql_migrations WHERE filename = '0043_campaign_alias_selection.sql';
