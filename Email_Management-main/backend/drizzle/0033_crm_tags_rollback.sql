-- Undo migration 0033 (CRM step 5). Tags themselves (0031 tables) are kept.
DROP INDEX IF EXISTS crm_contact_recipients_campaign_idx;
DROP INDEX IF EXISTS crm_campaign_tags_tag_idx;
DROP INDEX IF EXISTS crm_contact_tags_tag_idx;
DROP TABLE IF EXISTS crm_campaign_settings;
