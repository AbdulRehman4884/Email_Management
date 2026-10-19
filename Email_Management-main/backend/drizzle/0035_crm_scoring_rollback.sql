-- Undo migration 0035 (CRM step 7). Scores, tiers and score events are kept (they are from 0031).
DROP INDEX IF EXISTS crm_contacts_score_updated_idx;
ALTER TABLE crm_contacts DROP COLUMN IF EXISTS score_updated_at;
ALTER TABLE crm_contacts DROP COLUMN IF EXISTS score_breakdown;
