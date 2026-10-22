-- Migration 0031: CRM lifecycle module (step 1 - database only)
-- ADDITIVE ONLY: creates new crm_* tables and adds nullable / defaulted columns
-- to email_replies and plans. Nothing is dropped, renamed or retyped.
-- Safe to run more than once (IF NOT EXISTS everywhere).
-- Must stay in sync with the "CRM Lifecycle Module" block in src/db/schema.ts.
-- Undo: drizzle/0031_crm_module_rollback.sql

-- ── Existing tables: new columns ─────────────────────────────────────────────
ALTER TABLE email_replies ADD COLUMN IF NOT EXISTS label varchar(30);
ALTER TABLE email_replies ADD COLUMN IF NOT EXISTS label_source varchar(20);
ALTER TABLE email_replies ADD COLUMN IF NOT EXISTS label_confidence numeric(5, 4);
ALTER TABLE email_replies ADD COLUMN IF NOT EXISTS labeled_at timestamp with time zone;
CREATE INDEX IF NOT EXISTS email_replies_label_idx ON email_replies (label);

ALTER TABLE plans ADD COLUMN IF NOT EXISTS crm_enabled boolean DEFAULT false NOT NULL;

-- ── crm_pipelines ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_pipelines (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_pipelines_user_idx ON crm_pipelines (user_id);

-- ── crm_pipeline_stages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  pipeline_id integer NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  color varchar(20) DEFAULT '#6366f1' NOT NULL,
  position integer DEFAULT 0 NOT NULL,
  type varchar(20) DEFAULT 'normal' NOT NULL,
  manual_only boolean DEFAULT false NOT NULL,
  stop_follow_ups boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT crm_pipeline_stages_pipeline_name_uq UNIQUE (pipeline_id, name)
);
CREATE INDEX IF NOT EXISTS crm_pipeline_stages_pipeline_idx ON crm_pipeline_stages (pipeline_id, position);

-- ── crm_contacts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_contacts (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email varchar(255) NOT NULL,
  name varchar(255),
  company varchar(255),
  custom_fields jsonb,
  notes text,
  pipeline_id integer REFERENCES crm_pipelines(id) ON DELETE SET NULL,
  stage_id integer REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,
  stage_entered_at timestamp with time zone,
  score integer DEFAULT 0 NOT NULL,
  score_tier varchar(10) DEFAULT 'cold' NOT NULL,
  last_reply_label varchar(30),
  last_inbound_at timestamp with time zone,
  last_outbound_at timestamp with time zone,
  needs_reply boolean DEFAULT false NOT NULL,
  needs_reply_since timestamp with time zone,
  needs_reply_notified_at timestamp with time zone,
  snoozed_until timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT crm_contacts_user_email_uq UNIQUE (user_id, email)
);
CREATE INDEX IF NOT EXISTS crm_contacts_user_stage_idx ON crm_contacts (user_id, stage_id);
CREATE INDEX IF NOT EXISTS crm_contacts_user_needs_reply_idx ON crm_contacts (user_id, needs_reply);
CREATE INDEX IF NOT EXISTS crm_contacts_user_score_idx ON crm_contacts (user_id, score);

-- ── crm_contact_recipients (recipient row -> contact) ───────────────────────
CREATE TABLE IF NOT EXISTS crm_contact_recipients (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  contact_id integer NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  recipient_id integer NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  campaign_id integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT crm_contact_recipients_recipient_uq UNIQUE (recipient_id)
);
CREATE INDEX IF NOT EXISTS crm_contact_recipients_contact_idx ON crm_contact_recipients (contact_id);

-- ── crm_rules ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_rules (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pipeline_id integer NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  from_stage_id integer REFERENCES crm_pipeline_stages(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  priority integer DEFAULT 0 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  "trigger" varchar(50) NOT NULL,
  conditions jsonb DEFAULT '{"op":"AND","items":[]}'::jsonb NOT NULL,
  actions jsonb DEFAULT '[]'::jsonb NOT NULL,
  forward_only boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_rules_pipeline_active_idx ON crm_rules (pipeline_id, is_active);

-- ── crm_stage_history ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_stage_history (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  contact_id integer NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  from_stage_id integer REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id integer REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,
  rule_id integer REFERENCES crm_rules(id) ON DELETE SET NULL,
  changed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  reason varchar(255),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_stage_history_contact_idx ON crm_stage_history (contact_id, created_at);

-- ── crm_tags + join tables ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_tags (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  color varchar(20) DEFAULT '#6366f1' NOT NULL,
  scope varchar(20) DEFAULT 'both' NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT crm_tags_user_name_uq UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS crm_contact_tags (
  contact_id integer NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  tag_id integer NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
  CONSTRAINT crm_contact_tags_pk PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE IF NOT EXISTS crm_campaign_tags (
  campaign_id integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tag_id integer NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
  CONSTRAINT crm_campaign_tags_pk PRIMARY KEY (campaign_id, tag_id)
);

-- ── crm_score_events ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_score_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  contact_id integer NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  points integer NOT NULL,
  reason varchar(255) NOT NULL,
  source_type varchar(30) NOT NULL,
  source_id integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_score_events_contact_idx ON crm_score_events (contact_id, created_at);

-- ── crm_settings (one row per user) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_settings (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  needs_reply_after_hours integer DEFAULT 24 NOT NULL,
  reminder_email_digest boolean DEFAULT false NOT NULL,
  score_weights jsonb DEFAULT '{}'::jsonb NOT NULL,
  hot_threshold integer DEFAULT 70 NOT NULL,
  warm_threshold integer DEFAULT 40 NOT NULL,
  ai_labeling_enabled boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
