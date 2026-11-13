-- Migration 0041: campaign automations (follow-ups that go out by themselves after a campaign's first email).
-- Run after 0040_crm_automations.sql. ADDITIVE ONLY for existing tables: no column of campaigns, recipients or any
-- other existing table is changed; a campaign is linked to its automation through a new table.
-- Changes only the automation tables of 0040 (not deployed before this one). Safe to run more than once.
-- Must stay in sync with the automations block in src/db/schema.ts.
-- Undo: drizzle/0041_campaign_automations_rollback.sql

-- ── crm_automations.kind: 'form' (started by a form) | 'campaign' (follow-ups of campaigns) ──
ALTER TABLE crm_automations ADD COLUMN IF NOT EXISTS kind varchar(20) DEFAULT 'form' NOT NULL;
DO $$ BEGIN
  ALTER TABLE crm_automations ADD CONSTRAINT crm_automations_kind_chk CHECK (kind IN ('form', 'campaign'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── crm_automation_runs: a campaign run belongs to one campaign recipient (the CRM lead is optional) ──
ALTER TABLE crm_automation_runs ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE crm_automation_runs ADD COLUMN IF NOT EXISTS campaign_id integer REFERENCES campaigns(id) ON DELETE CASCADE;
ALTER TABLE crm_automation_runs ADD COLUMN IF NOT EXISTS recipient_id integer REFERENCES recipients(id) ON DELETE CASCADE;
DO $$ BEGIN
  ALTER TABLE crm_automation_runs ADD CONSTRAINT crm_automation_runs_target_chk CHECK (contact_id IS NOT NULL OR recipient_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- A campaign recipient goes through its campaign's automation once.
CREATE UNIQUE INDEX IF NOT EXISTS crm_automation_runs_recipient_uq ON crm_automation_runs (recipient_id) WHERE recipient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_automation_runs_campaign_idx ON crm_automation_runs (campaign_id, status) WHERE campaign_id IS NOT NULL;

-- ── crm_campaign_automations: the one automation of a campaign (one automation can be on many campaigns) ──
--   Chosen while the campaign is a draft; locked once the campaign has started.
CREATE TABLE IF NOT EXISTS crm_campaign_automations (
  campaign_id integer PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  automation_id integer NOT NULL REFERENCES crm_automations(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_campaign_automations_automation_idx ON crm_campaign_automations (automation_id);
