-- Rollback for 0032_crm_rules.sql. Removes ONLY what 0032 added (step 3).
-- Rules in crm_rules are kept; scheduled CRM follow-ups are lost.

DROP TABLE IF EXISTS crm_scheduled_follow_ups;
DROP INDEX IF EXISTS crm_rules_pipeline_trigger_idx;
ALTER TABLE crm_pipelines DROP COLUMN IF EXISTS rules_seeded_at;
ALTER TABLE crm_contacts DROP COLUMN IF EXISTS last_opened_at;
ALTER TABLE crm_contacts DROP COLUMN IF EXISTS open_count;
ALTER TABLE crm_contacts DROP COLUMN IF EXISTS follow_ups_stopped_at;
ALTER TABLE crm_contacts DROP COLUMN IF EXISTS follow_ups_stopped;
