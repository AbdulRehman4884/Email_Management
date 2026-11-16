-- Migration 0032: CRM step 3 - rule engine support.
-- ADDITIVE ONLY: new columns with defaults + one new table. Nothing is dropped or renamed.
-- Safe to run more than once (IF NOT EXISTS everywhere). Run after 0031_crm_module.sql.
-- Must stay in sync with the CRM block in src/db/schema.ts.
-- Undo: drizzle/0032_crm_rules_rollback.sql

-- Contact: follow-up stop flag (stop_follow_ups action, bounce, unsubscribe) and open counter.
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS follow_ups_stopped boolean DEFAULT false NOT NULL;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS follow_ups_stopped_at timestamp with time zone;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS open_count integer DEFAULT 0 NOT NULL;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS last_opened_at timestamp with time zone;

-- Pipeline: when the default rules were added (null = not yet; the engine seeds them once).
ALTER TABLE crm_pipelines ADD COLUMN IF NOT EXISTS rules_seeded_at timestamp with time zone;

-- Follow-ups planned by the schedule_follow_up rule action, sent by the CRM worker.
CREATE TABLE IF NOT EXISTS crm_scheduled_follow_ups (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id integer NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  recipient_id integer NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  campaign_id integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  rule_id integer REFERENCES crm_rules(id) ON DELETE SET NULL,
  -- campaigns.follow_up_templates[].id; null = next unsent template of the campaign
  template_id varchar(64),
  due_at timestamp with time zone NOT NULL,
  -- 'pending' | 'sent' | 'cancelled' | 'failed'
  status varchar(20) DEFAULT 'pending' NOT NULL,
  error varchar(1000),
  sent_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_scheduled_follow_ups_due_idx ON crm_scheduled_follow_ups (status, due_at);
CREATE INDEX IF NOT EXISTS crm_scheduled_follow_ups_contact_idx ON crm_scheduled_follow_ups (contact_id, status);

-- Faster rule lookups per event.
CREATE INDEX IF NOT EXISTS crm_rules_pipeline_trigger_idx ON crm_rules (pipeline_id, trigger, is_active);

-- Start open_count from what is already known (one open per recipient row that was opened).
UPDATE crm_contacts cc
   SET open_count = sub.c
  FROM (
    SELECT x.contact_id, count(*)::int AS c
      FROM crm_contact_recipients x
      JOIN recipients r ON r.id = x.recipient_id
     WHERE r.opened_at IS NOT NULL
     GROUP BY x.contact_id
  ) sub
 WHERE cc.id = sub.contact_id AND cc.open_count = 0;
