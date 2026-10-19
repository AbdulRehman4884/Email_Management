-- Migration 0034: CRM step 6 - "needs reply" reminders.
-- ADDITIVE ONLY: two new columns and two indexes. Nothing is dropped or renamed.
-- Safe to run more than once (IF NOT EXISTS everywhere). Run after 0033_crm_tags.sql.
-- crm_contacts.needs_reply / needs_reply_since / needs_reply_notified_at / snoozed_until and
-- crm_settings.needs_reply_after_hours / reminder_email_digest already exist (0031).
-- Must stay in sync with the CRM block in src/db/schema.ts.
-- Undo: drizzle/0034_crm_needs_reply_rollback.sql

-- "Mark as done" in the Inbox: replies received before this time no longer need a reply.
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS needs_reply_cleared_at timestamp with time zone;

-- Daily email digest: when it was last sent, so it goes out once a day.
ALTER TABLE crm_settings ADD COLUMN IF NOT EXISTS last_digest_sent_at timestamp with time zone;

-- The reminder job and the "Needs reply" tab only look at waiting leads.
CREATE INDEX IF NOT EXISTS crm_contacts_waiting_idx ON crm_contacts (user_id, needs_reply_since) WHERE needs_reply;

-- The notification bell reads the newest notifications of one user.
CREATE INDEX IF NOT EXISTS user_notifications_user_created_idx ON user_notifications (user_id, created_at);
