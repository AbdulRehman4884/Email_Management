-- Undo migration 0041 (campaign automations). Removes campaign links, campaign runs and the automation kind.
-- Campaign automations and their history are lost; form automations, campaigns and recipients are not touched.
-- Deploy code that does not use these columns before running this.
DROP TABLE IF EXISTS crm_campaign_automations;
DELETE FROM crm_automation_runs WHERE contact_id IS NULL;
DROP INDEX IF EXISTS crm_automation_runs_campaign_idx;
DROP INDEX IF EXISTS crm_automation_runs_recipient_uq;
ALTER TABLE crm_automation_runs DROP CONSTRAINT IF EXISTS crm_automation_runs_target_chk;
ALTER TABLE crm_automation_runs DROP COLUMN IF EXISTS recipient_id;
ALTER TABLE crm_automation_runs DROP COLUMN IF EXISTS campaign_id;
ALTER TABLE crm_automation_runs ALTER COLUMN contact_id SET NOT NULL;
DELETE FROM crm_automations WHERE kind = 'campaign';
ALTER TABLE crm_automations DROP CONSTRAINT IF EXISTS crm_automations_kind_chk;
ALTER TABLE crm_automations DROP COLUMN IF EXISTS kind;
