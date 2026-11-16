-- Undo migration 0036 (CRM step 9). Only indexes are removed; no data changes.
DROP INDEX IF EXISTS crm_contacts_user_recent_idx;
DROP INDEX IF EXISTS email_replies_recipient_idx;
DROP INDEX IF EXISTS email_replies_thread_idx;
