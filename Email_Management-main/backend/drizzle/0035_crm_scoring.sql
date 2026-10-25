-- Migration 0035: CRM step 7 - lead scoring.
-- ADDITIVE ONLY: two new columns and one index. Nothing is dropped or renamed.
-- Safe to run more than once (IF NOT EXISTS everywhere). Run after 0034_crm_needs_reply.sql.
-- crm_contacts.score / score_tier, crm_score_events and crm_settings.score_weights / hot_threshold /
-- warm_threshold already exist (0031).
-- Must stay in sync with the CRM block in src/db/schema.ts.
-- Undo: drizzle/0035_crm_scoring_rollback.sql

-- The parts of the current score ("why this score"), e.g. [{"key":"opens","label":"Opened 3 emails","points":15}, ...].
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS score_breakdown jsonb;
-- When the score was last calculated (the worker recalculates old scores, e.g. for "no activity for 14 days").
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS score_updated_at timestamp with time zone;

-- The worker picks leads whose score is oldest first.
CREATE INDEX IF NOT EXISTS crm_contacts_score_updated_idx ON crm_contacts (score_updated_at NULLS FIRST);
