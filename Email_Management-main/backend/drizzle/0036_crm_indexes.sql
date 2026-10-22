-- Migration 0036: CRM step 9 - indexes found with a 50 000-lead load test.
-- ADDITIVE ONLY: three indexes. No table or column is changed.
-- Safe to run more than once (IF NOT EXISTS). Run after 0035_crm_scoring.sql.
-- Must stay in sync with src/db/schema.ts.
-- Undo: drizzle/0036_crm_indexes_rollback.sql
--
-- Measured with 100 000 replies and 50 000 leads per user:
--   Inbox list (/api/replies)            90 s  -> 1.5 s   (also makes the old Inbox code fast)
--   CRM "Needs reply" list               1.2 s -> 3 ms
--   lead drawer timeline, reply labeling, needs-reply check: index scans instead of full scans
--   CRM table, default sort              20 ms -> 1 ms

-- Every message of a thread (Inbox unread / label / follow-up columns, CRM thread label).
CREATE INDEX IF NOT EXISTS email_replies_thread_idx
  ON email_replies ((COALESCE(thread_root_id, id)), direction, received_at DESC);

-- Replies of one recipient (CRM labeling, needs-reply, lead timeline, follow-up counts).
CREATE INDEX IF NOT EXISTS email_replies_recipient_idx
  ON email_replies (recipient_id, direction, received_at);

-- CRM leads table / board, default "recent activity" sort.
CREATE INDEX IF NOT EXISTS crm_contacts_user_recent_idx
  ON crm_contacts (user_id, (GREATEST(updated_at, COALESCE(last_inbound_at, updated_at))) DESC, id DESC);
