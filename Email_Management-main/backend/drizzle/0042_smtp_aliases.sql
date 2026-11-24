-- Migration 0042: per-alias sending. An SMTP profile (smtp_settings row) now owns a LIST of
-- sending aliases, and each alias has its own daily send quota (default 20). This replaces the
-- single from_email/from_name per profile as the unit that sends and is counted against a quota.
-- Run after 0041_campaign_automations.sql. ADDITIVE ONLY: no existing column is dropped or retyped;
-- smtp_settings.from_email / from_name stay (they become the profile's primary/first alias).
-- Backfills one alias per existing profile so every profile keeps working unchanged.
-- Safe to run more than once. Must stay in sync with smtpAliasesTable / emailSendLog.aliasId in src/db/schema.ts.
-- Undo: drizzle/0042_smtp_aliases_rollback.sql

-- ── smtp_aliases: the sending identities of one SMTP profile ──
CREATE TABLE IF NOT EXISTS smtp_aliases (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  smtp_settings_id integer NOT NULL REFERENCES smtp_settings(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_email varchar(255) NOT NULL,
  from_name varchar(100) DEFAULT '' NOT NULL,
  -- Max sends per calendar day for THIS alias; null = default 20, 0 = block, 1-20 = cap.
  daily_email_limit integer,
  -- Set to NOW() when daily_email_limit transitions from null/0 -> positive, so sends made before
  -- the cap was set don't count against it (mirrors smtp_settings.daily_limit_reset_at).
  daily_limit_reset_at timestamp with time zone,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
-- One alias address per profile (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS smtp_aliases_profile_email_uq
  ON smtp_aliases (smtp_settings_id, lower(from_email));
CREATE INDEX IF NOT EXISTS smtp_aliases_profile_idx ON smtp_aliases (smtp_settings_id);
CREATE INDEX IF NOT EXISTS smtp_aliases_user_idx ON smtp_aliases (user_id);

-- ── email_send_log.alias_id: which alias sent this email (nullable; old rows + non-alias sends are null) ──
ALTER TABLE email_send_log
  ADD COLUMN IF NOT EXISTS alias_id integer REFERENCES smtp_aliases(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS email_send_log_alias_idx ON email_send_log (alias_id, sent_at);

-- ── Backfill: every existing profile gets one alias (its current from_email / from_name / limit) ──
INSERT INTO smtp_aliases (smtp_settings_id, user_id, from_email, from_name, daily_email_limit, daily_limit_reset_at)
SELECT s.id, s.user_id, s.from_email, s.from_name, s.daily_email_limit, s.daily_limit_reset_at
FROM smtp_settings s
WHERE NOT EXISTS (
  SELECT 1 FROM smtp_aliases a
  WHERE a.smtp_settings_id = s.id AND lower(a.from_email) = lower(s.from_email)
);

-- ── Backfill: point existing send-log rows at their profile's primary (earliest) alias ──
UPDATE email_send_log l
SET alias_id = a.id
FROM smtp_aliases a
WHERE l.alias_id IS NULL
  AND a.smtp_settings_id = l.smtp_settings_id
  AND a.id = (
    SELECT min(a2.id) FROM smtp_aliases a2 WHERE a2.smtp_settings_id = l.smtp_settings_id
  );
