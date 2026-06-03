-- 0023_schema_drift_fixes.sql
--
-- Idempotent catch-up migration that closes the gap between schema.ts and the
-- production database.
--
-- Root cause: several migration SQL files existed in the drizzle/ directory but
-- were never registered in _journal.json and therefore never applied by
-- `drizzle-kit migrate`.  Some columns defined in schema.ts had no migration
-- file at all.  This single file brings the database to the current schema.ts
-- snapshot using IF NOT EXISTS / DO-block guards throughout.
--
-- Safe to apply on a live database: additive only, no drops, no renames.

-- ── users ─────────────────────────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferred_theme"              varchar(20) NOT NULL DEFAULT 'dark';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_otp_hash"      varchar(255);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_otp_expires_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_otp_used_at"   timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_requested_at"  timestamp;

-- ── smtp_settings ─────────────────────────────────────────────────────────────
ALTER TABLE "smtp_settings" ADD COLUMN IF NOT EXISTS "daily_email_limit" integer NOT NULL DEFAULT 50;

-- ── campaigns ─────────────────────────────────────────────────────────────────
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "smtp_settings_id"         integer;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "pause_at"                 varchar(30);
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "auto_pause_after_minutes" integer;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "available_columns"        varchar(2000);
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "follow_up_templates"      jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "follow_up_skip_confirm"   boolean NOT NULL DEFAULT false;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "daily_send_limit"         integer;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "send_weekdays"            jsonb;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "pause_reason"             varchar(50);
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "paused_at"               timestamp;

-- ── recipients ────────────────────────────────────────────────────────────────
ALTER TABLE "recipients" ADD COLUMN IF NOT EXISTS "custom_fields"   text;
ALTER TABLE "recipients" ADD COLUMN IF NOT EXISTS "last_send_error" varchar(2000);

-- ── email_send_log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_send_log" (
  "id"               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id"          integer NOT NULL REFERENCES "users"("id"),
  "smtp_settings_id" integer NOT NULL REFERENCES "smtp_settings"("id"),
  "campaign_id"      integer NOT NULL REFERENCES "campaigns"("id"),
  "sent_at"          timestamp WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "email_send_log_user_smtp_sent_idx"
  ON "email_send_log" ("user_id", "smtp_settings_id", "sent_at");

CREATE INDEX IF NOT EXISTS "email_send_log_campaign_sent_idx"
  ON "email_send_log" ("campaign_id", "sent_at");

-- ── follow_up_jobs ────────────────────────────────────────────────────────────
-- Full column set from schema.ts (max_run_minutes + send_weekdays were in later
-- migrations that also share the same journal/DB drift).
CREATE TABLE IF NOT EXISTS "follow_up_jobs" (
  "id"                          integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id"                     integer NOT NULL REFERENCES "users"("id"),
  "campaign_id"                 integer NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "scheduled_at"                varchar(30) NOT NULL,
  "status"                      varchar(20) NOT NULL DEFAULT 'pending',
  "template_id"                 varchar(64) NOT NULL,
  "prior_follow_up_count"       integer NOT NULL DEFAULT 0,
  "engagement"                  varchar(20) NOT NULL DEFAULT 'sent',
  "max_run_minutes"             integer,
  "send_weekdays"               jsonb,
  "paused_campaign_was_running" boolean NOT NULL DEFAULT false,
  "error_message"               varchar(2000),
  "started_at"                  timestamp,
  "completed_at"                timestamp,
  "created_at"                  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_follow_up_jobs_user_status"
  ON "follow_up_jobs" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "idx_follow_up_jobs_campaign"
  ON "follow_up_jobs" ("campaign_id");

-- email_replies.follow_up_template_id was bundled with follow_up_jobs in 0017
ALTER TABLE "email_replies" ADD COLUMN IF NOT EXISTS "follow_up_template_id" varchar(64);

-- ── user_notifications ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_notifications" (
  "id"         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id"    integer NOT NULL REFERENCES "users"("id"),
  "type"       varchar(50) NOT NULL,
  "payload"    jsonb,
  "read_at"    timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_user_notifications_user_id"
  ON "user_notifications" ("user_id");

-- ── campaign_sequence_touches (execution columns) ─────────────────────────────
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "execution_status" varchar(50) NOT NULL DEFAULT 'pending';
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "scheduled_for_at" timestamp;
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "sent_at"          timestamp;
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "message_id"       varchar(500);
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "attempt_count"    integer NOT NULL DEFAULT 0;
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "last_attempt_at"  timestamp;
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "retry_after_at"   timestamp;
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "last_error"       varchar(2000);
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "skipped_at"       timestamp;
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "skip_reason"      varchar(80);
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "bounced_at"       timestamp;
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "replied_at"       timestamp;
ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "unsubscribed_at"  timestamp;

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_sequence_touches_campaign_recipient_touch_idx"
  ON "campaign_sequence_touches" ("campaign_id", "recipient_id", "touch_number");

-- ── recipient_sequence_state ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "recipient_sequence_state" (
  "id"                          integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "campaign_id"                 integer NOT NULL REFERENCES "campaigns"("id"),
  "recipient_id"                integer NOT NULL REFERENCES "recipients"("id"),
  "current_touch_number"        integer NOT NULL DEFAULT 0,
  "next_touch_number"           integer NOT NULL DEFAULT 1,
  "next_scheduled_touch_at"     timestamp,
  "sequence_status"             varchar(50) NOT NULL DEFAULT 'pending',
  "sequence_started_at"         timestamp,
  "sequence_completed_at"       timestamp,
  "last_touch_sent_at"          timestamp,
  "last_reply_at"               timestamp,
  "last_bounce_at"              timestamp,
  "unsubscribed_at"             timestamp,
  "stop_reason"                 varchar(80),
  "sequence_paused"             boolean NOT NULL DEFAULT false,
  "retry_count"                 integer NOT NULL DEFAULT 0,
  "last_touch_message_id"       varchar(500),
  "last_attempted_touch_number" integer,
  "last_error"                  varchar(2000),
  "created_at"                  timestamp NOT NULL DEFAULT now(),
  "updated_at"                  timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "recipient_sequence_state_campaign_recipient_idx"
  ON "recipient_sequence_state" ("campaign_id", "recipient_id");

-- ── campaign_personalized_emails (later columns) ──────────────────────────────
ALTER TABLE "campaign_personalized_emails" ADD COLUMN IF NOT EXISTS "tone_used"           varchar(80);
ALTER TABLE "campaign_personalized_emails" ADD COLUMN IF NOT EXISTS "cta_type"            varchar(80);
ALTER TABLE "campaign_personalized_emails" ADD COLUMN IF NOT EXISTS "cta_text"            varchar(500);
ALTER TABLE "campaign_personalized_emails" ADD COLUMN IF NOT EXISTS "sequence_type"       varchar(80);
ALTER TABLE "campaign_personalized_emails" ADD COLUMN IF NOT EXISTS "touch_number"        integer NOT NULL DEFAULT 1;
ALTER TABLE "campaign_personalized_emails" ADD COLUMN IF NOT EXISTS "deliverability_risk" varchar(20);
ALTER TABLE "campaign_personalized_emails" ADD COLUMN IF NOT EXISTS "strategy_reasoning"  text;

-- ── reply_intelligence ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "reply_intelligence" (
  "id"                     integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "reply_id"               integer NOT NULL REFERENCES "email_replies"("id"),
  "campaign_id"            integer NOT NULL REFERENCES "campaigns"("id"),
  "recipient_id"           integer NOT NULL REFERENCES "recipients"("id"),
  "intent_category"        varchar(80) NOT NULL,
  "intent_confidence"      real NOT NULL DEFAULT 0,
  "sentiment"              varchar(30) NOT NULL DEFAULT 'neutral',
  "buying_signal_strength" integer NOT NULL DEFAULT 0,
  "urgency_level"          varchar(20) NOT NULL DEFAULT 'low',
  "meeting_likelihood"     integer NOT NULL DEFAULT 0,
  "objection_type"         varchar(50),
  "meeting_ready"          boolean NOT NULL DEFAULT false,
  "lead_temperature"       varchar(20) NOT NULL DEFAULT 'cold',
  "hot_lead_score"         integer NOT NULL DEFAULT 0,
  "requires_human_review"  boolean NOT NULL DEFAULT false,
  "review_status"          varchar(30) NOT NULL DEFAULT 'pending',
  "review_reason"          varchar(1000),
  "auto_reply_mode"        varchar(30) NOT NULL DEFAULT 'suggest_only',
  "detected_language"      varchar(20) NOT NULL DEFAULT 'en',
  "reply_summary"          varchar(1000),
  "suggested_reply_text"   text,
  "suggested_reply_html"   text,
  "suggestion_diagnostics" text,
  "reasoning"              text,
  "response_time_minutes"  integer,
  "prior_reply_count"      integer NOT NULL DEFAULT 0,
  "is_high_value_lead"     boolean NOT NULL DEFAULT false,
  "created_at"             timestamp NOT NULL DEFAULT now(),
  "updated_at"             timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "reply_intelligence_reply_idx"
  ON "reply_intelligence" ("reply_id");

CREATE UNIQUE INDEX IF NOT EXISTS "reply_intelligence_campaign_reply_idx"
  ON "reply_intelligence" ("campaign_id", "reply_id");

-- ── Indexes for newly added campaign columns ───────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_campaigns_smtp_settings_id"
  ON "campaigns" ("smtp_settings_id");

-- ── FK: campaigns.smtp_settings_id → smtp_settings.id ────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaigns_smtp_settings_id_smtp_settings_id_fk'
      AND conrelid = 'campaigns'::regclass
  ) THEN
    ALTER TABLE "campaigns"
      ADD CONSTRAINT "campaigns_smtp_settings_id_smtp_settings_id_fk"
      FOREIGN KEY ("smtp_settings_id")
      REFERENCES "smtp_settings"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $$;
