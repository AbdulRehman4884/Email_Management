-- Rollback for 0031_crm_module.sql
-- Removes ONLY what 0031 added. All CRM data (contacts, stages, tags, scores) is lost.
-- Existing campaign, recipient, reply and plan data is not touched.

DROP TABLE IF EXISTS crm_settings;
DROP TABLE IF EXISTS crm_score_events;
DROP TABLE IF EXISTS crm_campaign_tags;
DROP TABLE IF EXISTS crm_contact_tags;
DROP TABLE IF EXISTS crm_tags;
DROP TABLE IF EXISTS crm_stage_history;
DROP TABLE IF EXISTS crm_rules;
DROP TABLE IF EXISTS crm_contact_recipients;
DROP TABLE IF EXISTS crm_contacts;
DROP TABLE IF EXISTS crm_pipeline_stages;
DROP TABLE IF EXISTS crm_pipelines;

DROP INDEX IF EXISTS email_replies_label_idx;
ALTER TABLE email_replies DROP COLUMN IF EXISTS labeled_at;
ALTER TABLE email_replies DROP COLUMN IF EXISTS label_confidence;
ALTER TABLE email_replies DROP COLUMN IF EXISTS label_source;
ALTER TABLE email_replies DROP COLUMN IF EXISTS label;

ALTER TABLE plans DROP COLUMN IF EXISTS crm_enabled;
