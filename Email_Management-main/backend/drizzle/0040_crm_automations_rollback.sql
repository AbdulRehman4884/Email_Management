-- Undo migration 0040 (lead automations). Removes only the automation tables and the crm_forms.automation_id column.
-- All automations and their run history are lost. Forms, leads, campaigns and replies are not touched.
-- Deploy code that does not use these tables before running this.
DROP INDEX IF EXISTS crm_forms_automation_idx;
ALTER TABLE crm_forms DROP COLUMN IF EXISTS automation_id;
DROP TABLE IF EXISTS crm_automation_events;
DROP TABLE IF EXISTS crm_automation_runs;
DROP TABLE IF EXISTS crm_automations;
