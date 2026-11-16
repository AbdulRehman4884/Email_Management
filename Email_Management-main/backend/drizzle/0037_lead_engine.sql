-- Migration 0037: Lead Engine (Day 1 - database only)
-- ADDITIVE ONLY: 19 new tables + 2 plan columns. Nothing existing is dropped, renamed or retyped.
-- Safe to run more than once (IF NOT EXISTS everywhere). Run after 0036_crm_indexes.sql.
-- Tables follow the Lead Engine Use Case Document v1.0, section 7 (master 10, pipeline 6, workspace 1, compliance 2).
-- Must stay in sync with the "Lead Engine" block in src/db/schema.ts.
-- Undo: drizzle/0037_lead_engine_rollback.sql

-- ── Existing tables: plan flags ──────────────────────────────────────────────
ALTER TABLE plans ADD COLUMN IF NOT EXISTS lead_gen_enabled boolean DEFAULT false NOT NULL;
-- New leads per user per day (user timezone day). Use case default: 50.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS lead_gen_daily_limit integer DEFAULT 50 NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- Master data (shared knowledge base)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── sources: every data source with on/off, rate limit, daily cap ────────────
CREATE TABLE IF NOT EXISTS sources (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code varchar(30) NOT NULL,
  type varchar(20) NOT NULL,
  is_enabled boolean DEFAULT true NOT NULL,
  rate_per_min integer,
  daily_cap integer,
  notes text,
  -- Source block cooldown (429/403/CAPTCHA): no requests before this time.
  cooldown_until timestamp with time zone,
  CONSTRAINT sources_code_uq UNIQUE (code),
  CONSTRAINT sources_type_chk CHECK (type IN ('directory', 'search', 'website', 'provider', 'manual'))
);

-- ── companies: one master record per business ────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name varchar(255) NOT NULL,
  normalized_name varchar(255) NOT NULL,
  primary_domain varchar(255),
  website_url varchar(500),
  description text,
  category varchar(100),
  industry varchar(100),
  employee_range varchar(20),
  founded_year smallint,
  address varchar(500),
  city varchar(120),
  region varchar(120),
  country_code char(2),
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  tech_stack jsonb DEFAULT '[]'::jsonb NOT NULL,
  hiring_signals jsonb DEFAULT '{}'::jsonb NOT NULL,
  status varchar(20) DEFAULT 'active' NOT NULL,
  data_quality smallint DEFAULT 0 NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_enriched_at timestamp with time zone,
  next_refresh_at timestamp with time zone,
  deleted_at timestamp with time zone,
  -- The upper bound is checked in code (current year); a CHECK cannot use now().
  CONSTRAINT companies_founded_year_chk CHECK (founded_year IS NULL OR founded_year BETWEEN 1800 AND 2100),
  CONSTRAINT companies_status_chk CHECK (status IN ('active', 'closed', 'unknown')),
  CONSTRAINT companies_data_quality_chk CHECK (data_quality BETWEEN 0 AND 100),
  CONSTRAINT companies_description_len_chk CHECK (description IS NULL OR length(description) <= 2000)
);
-- A soft-deleted company does not block its domain.
CREATE UNIQUE INDEX IF NOT EXISTS companies_domain_uq ON companies (primary_domain)
  WHERE deleted_at IS NULL AND primary_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS companies_name_city_idx ON companies (normalized_name, city, country_code);
CREATE INDEX IF NOT EXISTS companies_category_city_idx ON companies (category, city, country_code);
CREATE INDEX IF NOT EXISTS companies_next_refresh_idx ON companies (next_refresh_at) WHERE deleted_at IS NULL;

-- What the company's website says it does (title, headings, meta keywords): matched against a search's focus.
-- Short phrases only, never page text. Added after the first draft of 0037, hence its own statement.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS site_topics jsonb DEFAULT '[]'::jsonb NOT NULL;

-- ── company_domains: a company can have several domains; dedupe uses this ────
CREATE TABLE IF NOT EXISTS company_domains (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  domain varchar(255) NOT NULL,
  is_primary boolean DEFAULT false NOT NULL,
  CONSTRAINT company_domains_domain_uq UNIQUE (domain)
);
CREATE INDEX IF NOT EXISTS company_domains_company_idx ON company_domains (company_id);

-- ── people: decision makers (public, business context only) ──────────────────
CREATE TABLE IF NOT EXISTS people (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  full_name varchar(255) NOT NULL,
  normalized_name varchar(255) NOT NULL,
  title varchar(255),
  seniority varchar(20),
  department varchar(50),
  current_company_id integer REFERENCES companies(id) ON DELETE SET NULL,
  city varchar(120),
  country_code char(2),
  linkedin_url varchar(500),
  confidence smallint DEFAULT 50 NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  next_refresh_at timestamp with time zone,
  deleted_at timestamp with time zone,
  CONSTRAINT people_seniority_chk CHECK (seniority IS NULL OR seniority IN ('owner', 'c_level', 'director', 'manager', 'staff')),
  CONSTRAINT people_confidence_chk CHECK (confidence BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS people_linkedin_uq ON people (linkedin_url)
  WHERE linkedin_url IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS people_company_idx ON people (current_company_id);
CREATE INDEX IF NOT EXISTS people_name_company_idx ON people (normalized_name, current_company_id);
CREATE INDEX IF NOT EXISTS people_next_refresh_idx ON people (next_refresh_at) WHERE deleted_at IS NULL;

-- ── employments: which person works / worked where (job changes) ─────────────
CREATE TABLE IF NOT EXISTS employments (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  person_id integer NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title varchar(255),
  is_current boolean DEFAULT true NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  ended_at timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS employments_current_uq ON employments (person_id, company_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS employments_company_current_idx ON employments (company_id) WHERE is_current;

-- ── contact_points: emails and phones of a company OR a person ───────────────
CREATE TABLE IF NOT EXISTS contact_points (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  company_id integer REFERENCES companies(id) ON DELETE CASCADE,
  person_id integer REFERENCES people(id) ON DELETE CASCADE,
  type varchar(10) NOT NULL,
  value varchar(255) NOT NULL,
  value_normalized varchar(255) NOT NULL,
  label varchar(20),
  verify_status varchar(15) DEFAULT 'unverified' NOT NULL,
  mx_valid boolean,
  source_id integer REFERENCES sources(id) ON DELETE SET NULL,
  source_url varchar(500),
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_verified_at timestamp with time zone,
  CONSTRAINT contact_points_one_owner CHECK (num_nonnulls(company_id, person_id) = 1),
  CONSTRAINT contact_points_type_chk CHECK (type IN ('email', 'phone', 'whatsapp')),
  CONSTRAINT contact_points_label_chk CHECK (label IS NULL OR label IN ('generic', 'direct', 'sales', 'support')),
  CONSTRAINT contact_points_verify_chk CHECK (verify_status IN ('unverified', 'valid', 'invalid', 'risky', 'guessed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_points_uq ON contact_points
  (type, value_normalized, COALESCE(company_id, 0), COALESCE(person_id, 0));
CREATE INDEX IF NOT EXISTS contact_points_value_idx ON contact_points (value_normalized);
CREATE INDEX IF NOT EXISTS contact_points_company_idx ON contact_points (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_points_person_idx ON contact_points (person_id) WHERE person_id IS NOT NULL;

-- ── social_profiles: LinkedIn / Facebook / Instagram / X / YouTube links ─────
CREATE TABLE IF NOT EXISTS social_profiles (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  company_id integer REFERENCES companies(id) ON DELETE CASCADE,
  person_id integer REFERENCES people(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL,
  url varchar(500) NOT NULL,
  found_via varchar(20) NOT NULL,
  snippet varchar(300),
  last_checked_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT social_profiles_one_owner CHECK (num_nonnulls(company_id, person_id) = 1),
  CONSTRAINT social_profiles_platform_chk CHECK (platform IN ('linkedin', 'facebook', 'instagram', 'x', 'youtube')),
  CONSTRAINT social_profiles_found_via_chk CHECK (found_via IN ('website_link', 'search_result', 'provider', 'manual')),
  CONSTRAINT social_profiles_platform_url_uq UNIQUE (platform, url)
);
CREATE INDEX IF NOT EXISTS social_profiles_company_idx ON social_profiles (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_profiles_person_idx ON social_profiles (person_id) WHERE person_id IS NOT NULL;

-- ── web_pages: pages read from a company site (hash only, never raw HTML) ────
CREATE TABLE IF NOT EXISTS web_pages (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url varchar(500) NOT NULL,
  page_type varchar(20) NOT NULL,
  http_status smallint,
  content_hash char(64),
  robots_allowed boolean DEFAULT true NOT NULL,
  last_fetched_at timestamp with time zone,
  CONSTRAINT web_pages_url_uq UNIQUE (url),
  CONSTRAINT web_pages_type_chk CHECK (page_type IN ('home', 'about', 'contact', 'team', 'careers', 'other'))
);
CREATE INDEX IF NOT EXISTS web_pages_company_idx ON web_pages (company_id);

-- ── entity_merges: two duplicates joined (undo + audit) ──────────────────────
CREATE TABLE IF NOT EXISTS entity_merges (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  entity_type varchar(10) NOT NULL,
  winner_id integer NOT NULL,
  loser_id integer NOT NULL,
  reason varchar(100) NOT NULL,
  merged_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT entity_merges_type_chk CHECK (entity_type IN ('company', 'person'))
);
CREATE INDEX IF NOT EXISTS entity_merges_loser_idx ON entity_merges (entity_type, loser_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- Collection pipeline (jobs + schedule)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── saved_searches: the user's ICP ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_searches (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  category varchar(100),
  keywords jsonb DEFAULT '[]'::jsonb NOT NULL,
  city varchar(120),
  region varchar(120),
  country_code char(2),
  include_people boolean DEFAULT false NOT NULL,
  person_filters jsonb DEFAULT '{}'::jsonb NOT NULL,
  target_per_run integer DEFAULT 20 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT saved_searches_target_chk CHECK (target_per_run BETWEEN 1 AND 100)
);
CREATE INDEX IF NOT EXISTS saved_searches_user_active_idx ON saved_searches (user_id, is_active);

-- ── search_schedules: when a saved search runs (one schedule per search) ─────
CREATE TABLE IF NOT EXISTS search_schedules (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  saved_search_id integer NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  frequency varchar(10) DEFAULT 'daily' NOT NULL,
  run_at_local time DEFAULT '09:00' NOT NULL,
  timezone varchar(50) DEFAULT 'Asia/Karachi' NOT NULL,
  -- Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64. 127 = every day.
  weekdays_mask smallint DEFAULT 127 NOT NULL,
  next_run_at timestamp with time zone,
  last_run_at timestamp with time zone,
  is_paused boolean DEFAULT false NOT NULL,
  consecutive_failures smallint DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT search_schedules_search_uq UNIQUE (saved_search_id),
  CONSTRAINT search_schedules_frequency_chk CHECK (frequency IN ('daily', 'weekly')),
  CONSTRAINT search_schedules_mask_chk CHECK (weekdays_mask BETWEEN 1 AND 127)
);
CREATE INDEX IF NOT EXISTS search_schedules_due_idx ON search_schedules (next_run_at) WHERE NOT is_paused;

-- ── scrape_runs: one run (scheduled, manual or system refresh) ───────────────
CREATE TABLE IF NOT EXISTS scrape_runs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  saved_search_id integer REFERENCES saved_searches(id) ON DELETE SET NULL,
  schedule_id integer REFERENCES search_schedules(id) ON DELETE SET NULL,
  -- Date in the user's timezone (unique per schedule: never two runs in one day).
  run_date date NOT NULL,
  run_type varchar(10) NOT NULL,
  status varchar(15) DEFAULT 'queued' NOT NULL,
  stats jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  started_at timestamp with time zone,
  heartbeat_at timestamp with time zone,
  completed_at timestamp with time zone,
  error varchar(1000),
  CONSTRAINT scrape_runs_type_chk CHECK (run_type IN ('search', 'refresh', 'manual')),
  CONSTRAINT scrape_runs_status_chk CHECK (status IN ('queued', 'running', 'done', 'partial', 'failed', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS scrape_runs_once_per_day ON scrape_runs (schedule_id, run_date)
  WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scrape_runs_user_started_idx ON scrape_runs (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS scrape_runs_active_idx ON scrape_runs (status) WHERE status IN ('queued', 'running');

-- ── observations: every extracted fact, where and when (provenance) ──────────
CREATE TABLE IF NOT EXISTS observations (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  entity_type varchar(10) NOT NULL,
  -- Polymorphic, no FK (log table).
  entity_id integer NOT NULL,
  field varchar(50) NOT NULL,
  value jsonb NOT NULL,
  source_id integer REFERENCES sources(id) ON DELETE SET NULL,
  source_url varchar(500),
  run_id integer REFERENCES scrape_runs(id) ON DELETE SET NULL,
  confidence smallint DEFAULT 50 NOT NULL,
  observed_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT observations_type_chk CHECK (entity_type IN ('company', 'person')),
  CONSTRAINT observations_confidence_chk CHECK (confidence BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS observations_entity_idx ON observations (entity_type, entity_id, field);
-- Purged after 180 days.
CREATE INDEX IF NOT EXISTS observations_observed_idx ON observations (observed_at);
-- Dedupe: a business seen again under the same source id (e.g. "osm:node/123") is the same company.
CREATE INDEX IF NOT EXISTS observations_external_id_idx ON observations ((value #>> '{}')) WHERE field = 'external_id';

-- ── scrape_tasks: small units of a run, each retried on its own ──────────────
CREATE TABLE IF NOT EXISTS scrape_tasks (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  run_id integer NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
  source_id integer REFERENCES sources(id) ON DELETE SET NULL,
  task_type varchar(20) NOT NULL,
  target varchar(500) NOT NULL,
  company_id integer REFERENCES companies(id) ON DELETE SET NULL,
  -- Extra input for the task (e.g. the discovered business to resolve).
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  status varchar(12) DEFAULT 'pending' NOT NULL,
  attempts smallint DEFAULT 0 NOT NULL,
  priority smallint DEFAULT 0 NOT NULL,
  next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  locked_at timestamp with time zone,
  heartbeat_at timestamp with time zone,
  last_error varchar(500),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  CONSTRAINT scrape_tasks_type_chk CHECK (task_type IN ('discover', 'fetch_site', 'find_social', 'verify_email', 'provider_enrich')),
  CONSTRAINT scrape_tasks_status_chk CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped', 'cancelled')),
  CONSTRAINT scrape_tasks_run_target_uq UNIQUE (run_id, task_type, target)
);
CREATE INDEX IF NOT EXISTS scrape_tasks_claim_idx ON scrape_tasks (status, next_attempt_at, priority) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scrape_tasks_running_idx ON scrape_tasks (heartbeat_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS scrape_tasks_run_idx ON scrape_tasks (run_id, status);

-- ── source_daily_usage: requests and blocks per source per day ───────────────
CREATE TABLE IF NOT EXISTS source_daily_usage (
  source_id integer NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  day date NOT NULL,
  requests_used integer DEFAULT 0 NOT NULL,
  blocked_count integer DEFAULT 0 NOT NULL,
  CONSTRAINT source_daily_usage_pk PRIMARY KEY (source_id, day)
);

-- ── leadgen_cache: cached answers of outside APIs (geocode, Overpass, search) ─
CREATE TABLE IF NOT EXISTS leadgen_cache (
  cache_key varchar(300) PRIMARY KEY,
  payload jsonb NOT NULL,
  expires_at timestamp with time zone NOT NULL
);
CREATE INDEX IF NOT EXISTS leadgen_cache_expires_idx ON leadgen_cache (expires_at);

-- ═════════════════════════════════════════════════════════════════════════════
-- Workspace (per user)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS workspace_leads (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_id integer REFERENCES people(id) ON DELETE CASCADE,
  saved_search_id integer REFERENCES saved_searches(id) ON DELETE SET NULL,
  first_run_id integer REFERENCES scrape_runs(id) ON DELETE SET NULL,
  status varchar(20) DEFAULT 'new' NOT NULL,
  fit_score smallint DEFAULT 0 NOT NULL,
  score_tier varchar(10) DEFAULT 'cold' NOT NULL,
  score_breakdown jsonb DEFAULT '[]'::jsonb NOT NULL,
  crm_contact_id integer REFERENCES crm_contacts(id) ON DELETE SET NULL,
  found_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT workspace_leads_status_chk CHECK (status IN ('new', 'reviewed', 'saved_to_crm', 'in_campaign', 'rejected')),
  CONSTRAINT workspace_leads_tier_chk CHECK (score_tier IN ('hot', 'warm', 'cold')),
  CONSTRAINT workspace_leads_score_chk CHECK (fit_score BETWEEN 0 AND 100)
);
-- A user gets a company/person only once (daily runs never duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS workspace_leads_uq ON workspace_leads (user_id, company_id, COALESCE(person_id, 0));
CREATE INDEX IF NOT EXISTS workspace_leads_user_status_idx ON workspace_leads (user_id, status, fit_score DESC);
CREATE INDEX IF NOT EXISTS workspace_leads_search_found_idx ON workspace_leads (saved_search_id, found_at DESC);

-- ═════════════════════════════════════════════════════════════════════════════
-- Compliance
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  request_type varchar(10) NOT NULL,
  -- sha256 of the email or LinkedIn URL. The identifier itself is never stored.
  identifier_hash char(64) NOT NULL,
  identifier_type varchar(15) NOT NULL,
  status varchar(12) DEFAULT 'received' NOT NULL,
  -- sha256 of the one-time confirmation token sent to the identifier.
  verify_token_hash char(64),
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  verified_at timestamp with time zone,
  processed_at timestamp with time zone,
  CONSTRAINT dsr_type_chk CHECK (request_type IN ('opt_out', 'erasure', 'access')),
  CONSTRAINT dsr_identifier_type_chk CHECK (identifier_type IN ('email', 'domain', 'linkedin_url')),
  CONSTRAINT dsr_status_chk CHECK (status IN ('received', 'verified', 'done', 'rejected'))
);
CREATE INDEX IF NOT EXISTS dsr_identifier_idx ON data_subject_requests (identifier_hash);

CREATE TABLE IF NOT EXISTS do_not_collect (
  identifier_hash char(64) PRIMARY KEY,
  identifier_type varchar(15) NOT NULL,
  added_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT do_not_collect_type_chk CHECK (identifier_type IN ('email', 'domain', 'linkedin_url'))
);

-- ═════════════════════════════════════════════════════════════════════════════
-- Seeds: sources (kept on re-run; admin changes are not overwritten)
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO sources (code, type, is_enabled, rate_per_min, daily_cap, notes) VALUES
  ('osm',             'directory', true,  50,   5000, 'OpenStreetMap Nominatim (max 1 req/sec, identifying User-Agent) + Overpass. ODbL: attribution required.'),
  ('ddg',             'search',    true,  10,   500,  'DuckDuckGo HTML results. Free, blocks at volume; prefer serp_api for daily scale.'),
  ('serp_api',        'search',    false, 60,   3000, 'Paid SERP API (e.g. DataForSEO). Enabled when LEADGEN_SERP_API_KEY is set.'),
  ('website',         'website',   true,  30,   NULL, 'Company websites: robots.txt respected, 1 request / 2 sec per host, 1 MB cap, no login/CAPTCHA bypass.'),
  ('search_linkedin', 'search',    true,  10,   500,  'LinkedIn URLs from search engine results only. linkedin.com is never requested.'),
  ('pdl',             'provider',  false, 30,   100,  'People Data Labs (licensed). Hot leads only, answers cached 90 days. Needs LEADGEN_PDL_API_KEY; check the contract terms before enabling.')
ON CONFLICT (code) DO NOTHING;
