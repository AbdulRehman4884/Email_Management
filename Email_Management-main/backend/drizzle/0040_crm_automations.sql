-- Migration 0040: lead automations (a form starts an automation: emails, waits, reminders, calls).
-- ADDITIVE ONLY: three new tables and one new nullable column on crm_forms (existing forms get NULL = no automation).
-- No existing data is changed. Safe to run more than once (IF NOT EXISTS everywhere). Run after 0037_crm_tracking_forms.sql.
-- Must stay in sync with the automations block in src/db/schema.ts.
-- Undo: drizzle/0040_crm_automations_rollback.sql

-- ── crm_automations (built by the user on the Automations page) ─────────────
--   smtp_settings_id  the email account the automation's emails are sent from
--   steps             [{ id, type: 'email'|'wait'|'remind'|'tag'|'stage'|'call', ... }]; a call step holds the
--                     steps for each call result: { outcomes: { interested: [...], no_answer: [...], not_interested: [...] } }
CREATE TABLE IF NOT EXISTS crm_automations (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  smtp_settings_id integer REFERENCES smtp_settings(id) ON DELETE SET NULL,
  steps jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_automations_user_idx ON crm_automations (user_id);

-- ── crm_automation_runs (one lead going through one automation) ─────────────
--   status         active (waits for next_run_at) | running (a worker is on it) | waiting_call (waits for the call result)
--                  | completed | stopped
--   step_index     position in the main steps; while branch is set it points at the call step
--   branch         the call result being followed (interested | no_answer | not_interested), branch_index = position in it
--   call_attempts  call reminders sent for the current call step ("No answer" can repeat the call)
--   step_failures  failed sends of the current email step (skipped after 3)
--   thread_*       first email of the run; a later email with an empty subject is sent as a reply in that thread
--   stop_code      unsubscribed | bounced | won_lost | manual (why the run stopped)
CREATE TABLE IF NOT EXISTS crm_automation_runs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  automation_id integer NOT NULL REFERENCES crm_automations(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id integer NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  form_id integer REFERENCES crm_forms(id) ON DELETE SET NULL,
  status varchar(20) DEFAULT 'active' NOT NULL,
  step_index integer DEFAULT 0 NOT NULL,
  branch varchar(20),
  branch_index integer DEFAULT 0 NOT NULL,
  call_attempts integer DEFAULT 0 NOT NULL,
  step_failures integer DEFAULT 0 NOT NULL,
  next_run_at timestamp with time zone DEFAULT now(),
  thread_message_id varchar(500),
  thread_subject varchar(255),
  emails_sent integer DEFAULT 0 NOT NULL,
  stop_code varchar(30),
  stop_reason varchar(255),
  last_error varchar(1000),
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  finished_at timestamp with time zone,
  CONSTRAINT crm_automation_runs_status_chk CHECK (status IN ('active', 'running', 'waiting_call', 'completed', 'stopped')),
  CONSTRAINT crm_automation_runs_branch_chk CHECK (branch IS NULL OR branch IN ('interested', 'no_answer', 'not_interested'))
);
-- A lead is in the same automation at most once at a time.
CREATE UNIQUE INDEX IF NOT EXISTS crm_automation_runs_open_uq
  ON crm_automation_runs (automation_id, contact_id) WHERE status IN ('active', 'running', 'waiting_call');
CREATE INDEX IF NOT EXISTS crm_automation_runs_due_idx ON crm_automation_runs (status, next_run_at);
CREATE INDEX IF NOT EXISTS crm_automation_runs_automation_idx ON crm_automation_runs (automation_id, status);
CREATE INDEX IF NOT EXISTS crm_automation_runs_contact_idx ON crm_automation_runs (contact_id);
CREATE INDEX IF NOT EXISTS crm_automation_runs_user_idx ON crm_automation_runs (user_id, status);

-- ── crm_automation_events (what each run did: emails sent, reminders, call results, stops) ──
--   kind  started | email | remind | tag | stage | call | call_result | wait | skipped | error | stopped | completed
--   smtp_settings_id is set for sent emails (daily sending limit of the account)
CREATE TABLE IF NOT EXISTS crm_automation_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  run_id integer NOT NULL REFERENCES crm_automation_runs(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind varchar(20) NOT NULL,
  detail varchar(500),
  smtp_settings_id integer REFERENCES smtp_settings(id) ON DELETE SET NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_automation_events_run_idx ON crm_automation_events (run_id, created_at);
CREATE INDEX IF NOT EXISTS crm_automation_events_smtp_idx ON crm_automation_events (smtp_settings_id, created_at) WHERE kind = 'email';

-- ── crm_forms.automation_id (the one automation a form starts; one automation can be on many forms) ──
ALTER TABLE crm_forms ADD COLUMN IF NOT EXISTS automation_id integer REFERENCES crm_automations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS crm_forms_automation_idx ON crm_forms (automation_id);
