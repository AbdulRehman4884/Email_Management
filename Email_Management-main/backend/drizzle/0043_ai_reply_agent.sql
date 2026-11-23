-- Migration 0043: AI reply agent (answers lead replies: approve-first or full-auto).
-- ADDITIVE ONLY: two new tables, no existing table is changed. Safe to run more than once.
-- Read and written with plain SQL in src/lib/aiReply/ (no Drizzle table objects).
-- Undo: drizzle/0043_ai_reply_agent_rollback.sql

-- One row per user. No row = the agent is off (the default).
CREATE TABLE IF NOT EXISTS ai_reply_settings (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 'off' | 'approve' (draft waits in the Inbox) | 'auto' (sent by itself after delay_minutes)
  mode varchar(10) DEFAULT 'off' NOT NULL,
  -- Reply labels the agent answers (see constants/replyLabels.ts).
  labels jsonb DEFAULT '["interested","question","neutral"]'::jsonb NOT NULL,
  delay_minutes integer DEFAULT 3 NOT NULL,
  max_per_thread integer DEFAULT 3 NOT NULL,
  daily_limit integer DEFAULT 50 NOT NULL,
  -- What the user sells and the results it brings (the AI never invents more than this).
  offer text DEFAULT '' NOT NULL,
  -- Booking link the AI offers to move the talk to a call.
  meeting_link varchar(500) DEFAULT '' NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_reply_settings_mode_chk CHECK (mode IN ('off', 'approve', 'auto')),
  CONSTRAINT ai_reply_settings_delay_chk CHECK (delay_minutes BETWEEN 0 AND 120),
  CONSTRAINT ai_reply_settings_thread_chk CHECK (max_per_thread BETWEEN 1 AND 10),
  CONSTRAINT ai_reply_settings_daily_chk CHECK (daily_limit BETWEEN 1 AND 1000)
);

-- One AI answer per inbound reply.
CREATE TABLE IF NOT EXISTS ai_reply_drafts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_id integer NOT NULL REFERENCES email_replies(id) ON DELETE CASCADE,
  thread_root_id integer NOT NULL,
  campaign_id integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id integer NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  label varchar(30),
  -- 'price' | 'busy' | 'timing' | 'competitor' | 'not_now' | 'info' | null
  objection varchar(20),
  body text NOT NULL,
  -- 'pending' (waits for approval) | 'scheduled' (auto, goes out at send_after) | 'sent' | 'discarded' | 'used'
  -- (copied into the Inbox reply box) | 'skipped' (not sent: the user answered, meeting booked, limit, ...) | 'failed'
  status varchar(12) NOT NULL,
  send_after timestamp with time zone,
  sent_at timestamp with time zone,
  note varchar(300),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_reply_drafts_reply_uq UNIQUE (reply_id),
  CONSTRAINT ai_reply_drafts_status_chk CHECK (status IN ('pending', 'scheduled', 'sent', 'discarded', 'used', 'skipped', 'failed'))
);
CREATE INDEX IF NOT EXISTS ai_reply_drafts_thread_idx ON ai_reply_drafts (thread_root_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_reply_drafts_due_idx ON ai_reply_drafts (send_after) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS ai_reply_drafts_user_idx ON ai_reply_drafts (user_id, status, created_at DESC);
