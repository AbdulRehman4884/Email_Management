-- Undo migration 0037 (Lead Engine). Drops all 19 lead engine tables and their data,
-- and the two plan columns. Existing tables (users, plans, crm_contacts ...) are kept.
DROP TABLE IF EXISTS do_not_collect;
DROP TABLE IF EXISTS data_subject_requests;
DROP TABLE IF EXISTS workspace_leads;
DROP TABLE IF EXISTS leadgen_cache;
DROP TABLE IF EXISTS source_daily_usage;
DROP TABLE IF EXISTS scrape_tasks;
DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS scrape_runs;
DROP TABLE IF EXISTS search_schedules;
DROP TABLE IF EXISTS saved_searches;
DROP TABLE IF EXISTS entity_merges;
DROP TABLE IF EXISTS web_pages;
DROP TABLE IF EXISTS social_profiles;
DROP TABLE IF EXISTS contact_points;
DROP TABLE IF EXISTS employments;
DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS company_domains;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS sources;
ALTER TABLE plans DROP COLUMN IF EXISTS lead_gen_daily_limit;
ALTER TABLE plans DROP COLUMN IF EXISTS lead_gen_enabled;
