-- Migration 0033: CRM step 5 - tags on campaigns and leads.
-- ADDITIVE ONLY: one new table and a few indexes. Nothing is dropped or renamed.
-- Safe to run more than once (IF NOT EXISTS everywhere). Run after 0032_crm_rules.sql.
-- crm_tags, crm_contact_tags and crm_campaign_tags already exist (0031).
-- Must stay in sync with the CRM block in src/db/schema.ts.
-- Undo: drizzle/0033_crm_tags_rollback.sql

-- Per-campaign CRM options chosen when the campaign is created (or later on the campaign page):
--   pipeline_id   new leads from this campaign start in this pipeline (null = the default pipeline)
--   auto_tag_ids  tags added to every lead of this campaign
CREATE TABLE IF NOT EXISTS crm_campaign_settings (
  campaign_id integer PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pipeline_id integer REFERENCES crm_pipelines(id) ON DELETE SET NULL,
  auto_tag_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_campaign_settings_user_idx ON crm_campaign_settings (user_id);

-- Filters: "leads with tag X", "campaigns with tag X", "leads of campaign X".
CREATE INDEX IF NOT EXISTS crm_contact_tags_tag_idx ON crm_contact_tags (tag_id);
CREATE INDEX IF NOT EXISTS crm_campaign_tags_tag_idx ON crm_campaign_tags (tag_id);
CREATE INDEX IF NOT EXISTS crm_contact_recipients_campaign_idx ON crm_contact_recipients (campaign_id);
