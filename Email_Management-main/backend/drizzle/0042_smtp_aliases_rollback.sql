-- Rollback of 0042_smtp_aliases.sql. Drops per-alias sending and restores the single-alias model.
-- email_send_log history survives (alias_id column is dropped, smtp_settings_id stays intact).
DROP INDEX IF EXISTS email_send_log_alias_idx;
ALTER TABLE email_send_log DROP COLUMN IF EXISTS alias_id;
DROP TABLE IF EXISTS smtp_aliases;
DELETE FROM _sql_migrations WHERE filename = '0042_smtp_aliases.sql';
