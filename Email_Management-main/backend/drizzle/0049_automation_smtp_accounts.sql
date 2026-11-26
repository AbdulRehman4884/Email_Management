-- 0049_automation_smtp_accounts
-- Let a form automation send from several email accounts (like a campaign).
-- smtp_setting_ids: the chosen accounts, in order; NULL = only smtp_settings_id (the existing behaviour).
-- smtp_settings_id stays the first chosen account, so older code and reports keep working.
-- Each new lead gets the account that sent the fewest emails today (and is under its daily limit);
-- every later email to that lead goes from the same account, so the thread is not broken.
ALTER TABLE crm_automations
  ADD COLUMN IF NOT EXISTS smtp_setting_ids jsonb;
