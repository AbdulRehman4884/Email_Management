-- Migration 0030: Add smtp_setting_ids array column to campaigns table
-- This allows a campaign to use multiple SMTP profiles for sending.
-- The existing smtp_settings_id column is kept for backwards-compatibility.

-- Add the smtp_setting_ids jsonb column with a default empty array
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS smtp_setting_ids jsonb DEFAULT '[]'::jsonb NOT NULL;

-- Backfill: if smtp_settings_id is set, populate smtp_setting_ids from it
UPDATE campaigns
  SET smtp_setting_ids = jsonb_build_array(smtp_settings_id)
  WHERE smtp_settings_id IS NOT NULL
    AND (smtp_setting_ids IS NULL OR smtp_setting_ids = '[]'::jsonb);
