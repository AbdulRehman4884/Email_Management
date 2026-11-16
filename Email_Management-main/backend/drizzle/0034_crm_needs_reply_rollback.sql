-- Undo migration 0034 (CRM step 6). needs_reply flags on contacts are kept (they are from 0031).
DROP INDEX IF EXISTS user_notifications_user_created_idx;
DROP INDEX IF EXISTS crm_contacts_waiting_idx;
ALTER TABLE crm_settings DROP COLUMN IF EXISTS last_digest_sent_at;
ALTER TABLE crm_contacts DROP COLUMN IF EXISTS needs_reply_cleared_at;
