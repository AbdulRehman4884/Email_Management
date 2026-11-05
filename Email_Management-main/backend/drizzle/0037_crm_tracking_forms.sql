-- Migration 0037: CRM step 10 - website visitor tracking and lead capture forms.
-- ADDITIVE ONLY: five new tables. No existing table or column is changed.
-- Safe to run more than once (IF NOT EXISTS everywhere). Run after 0036_crm_indexes.sql.
-- Must stay in sync with the CRM block in src/db/schema.ts.
-- Undo: drizzle/0037_crm_tracking_forms_rollback.sql

-- ── crm_sites (websites added in Settings > Website tracking) ───────────────
--   site_key          public id used by t.js (data-site="ST_...")
--   domain            host without scheme / "www." (e.g. myshop.com); visits from other hosts are rejected
--   key_pages         paths that count as key pages (e.g. {/pricing,/book-demo})
--   require_consent   t.js only reports visits after the page signals consent
--   installed_at      first visit received ("Installed")
CREATE TABLE IF NOT EXISTS crm_sites (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_key varchar(40) NOT NULL,
  domain varchar(255) NOT NULL,
  key_pages text[] DEFAULT '{}'::text[] NOT NULL,
  require_consent boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  installed_at timestamp with time zone,
  last_seen_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT crm_sites_site_key_uq UNIQUE (site_key),
  CONSTRAINT crm_sites_user_domain_uq UNIQUE (user_id, domain)
);
CREATE INDEX IF NOT EXISTS crm_sites_user_idx ON crm_sites (user_id);

-- ── crm_web_visitors (one row per browser cookie per site) ──────────────────
--   contact_id null = anonymous visitor
--   ip_hash         salted hash only, the full IP is never stored
--   clicked_at      first visit that came from an email link (?mf=)
--   last_alert_at   last "is on your key page" alert (max one per day)
CREATE TABLE IF NOT EXISTS crm_web_visitors (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id integer NOT NULL REFERENCES crm_sites(id) ON DELETE CASCADE,
  visitor_key varchar(64) NOT NULL,
  contact_id integer REFERENCES crm_contacts(id) ON DELETE SET NULL,
  ip_hash varchar(64),
  visit_count integer DEFAULT 0 NOT NULL,
  pageview_count integer DEFAULT 0 NOT NULL,
  clicked_at timestamp with time zone,
  last_alert_at timestamp with time zone,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT crm_web_visitors_site_key_uq UNIQUE (site_id, visitor_key)
);
CREATE INDEX IF NOT EXISTS crm_web_visitors_user_contact_idx ON crm_web_visitors (user_id, contact_id);
CREATE INDEX IF NOT EXISTS crm_web_visitors_last_seen_idx ON crm_web_visitors (last_seen_at);

-- ── crm_web_pageviews (every page view reported by t.js) ────────────────────
--   via_link      this view came with a valid ?mf= code (email link click)
--   recipient_id / campaign_id  the email the link was in (from the signed code)
CREATE TABLE IF NOT EXISTS crm_web_pageviews (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id integer NOT NULL REFERENCES crm_sites(id) ON DELETE CASCADE,
  visitor_id integer NOT NULL REFERENCES crm_web_visitors(id) ON DELETE CASCADE,
  contact_id integer REFERENCES crm_contacts(id) ON DELETE SET NULL,
  path varchar(1000) NOT NULL,
  title varchar(500),
  referrer varchar(1000),
  is_key_page boolean DEFAULT false NOT NULL,
  via_link boolean DEFAULT false NOT NULL,
  recipient_id integer REFERENCES recipients(id) ON DELETE SET NULL,
  campaign_id integer REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_web_pageviews_visitor_idx ON crm_web_pageviews (visitor_id, created_at);
CREATE INDEX IF NOT EXISTS crm_web_pageviews_contact_idx ON crm_web_pageviews (contact_id, created_at);
CREATE INDEX IF NOT EXISTS crm_web_pageviews_user_created_idx ON crm_web_pageviews (user_id, created_at);
CREATE INDEX IF NOT EXISTS crm_web_pageviews_created_idx ON crm_web_pageviews (created_at);

-- ── crm_forms (lead capture forms) ──────────────────────────────────────────
--   form_key      public id (data-form="FM_...", /f/FM_...)
--   fields        [{ "id", "type": "email|name|company|phone|message|text|number|dropdown", "label", "required", "options" }]
--   design        { "buttonText", "buttonColor", "textColor", "backgroundColor", "rounded", "popupDelaySeconds" }
--   captcha_*     optional Turnstile / reCAPTCHA check
--   add_to_campaign_id  optional: new form leads are added to this campaign
CREATE TABLE IF NOT EXISTS crm_forms (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  form_key varchar(40) NOT NULL,
  name varchar(255) NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  title varchar(255),
  description varchar(1000),
  fields jsonb DEFAULT '[]'::jsonb NOT NULL,
  design jsonb DEFAULT '{}'::jsonb NOT NULL,
  success_message varchar(500),
  consent_enabled boolean DEFAULT false NOT NULL,
  consent_text varchar(500),
  pipeline_id integer REFERENCES crm_pipelines(id) ON DELETE SET NULL,
  stage_id integer REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,
  tag_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
  thank_you_enabled boolean DEFAULT false NOT NULL,
  thank_you_smtp_settings_id integer REFERENCES smtp_settings(id) ON DELETE SET NULL,
  thank_you_subject varchar(255),
  thank_you_body text,
  notify_enabled boolean DEFAULT true NOT NULL,
  notify_email varchar(255),
  captcha_provider varchar(20),
  captcha_site_key varchar(255),
  captcha_secret_key varchar(255),
  add_to_campaign_id integer REFERENCES campaigns(id) ON DELETE SET NULL,
  view_count integer DEFAULT 0 NOT NULL,
  submission_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT crm_forms_form_key_uq UNIQUE (form_key)
);
CREATE INDEX IF NOT EXISTS crm_forms_user_idx ON crm_forms (user_id);

-- ── crm_form_submissions ────────────────────────────────────────────────────
--   answers           [{ "fieldId", "label", "value" }] stored as plain text
--   created_contact   this submission created the lead (lead source "Form: <name>")
CREATE TABLE IF NOT EXISTS crm_form_submissions (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  form_id integer NOT NULL REFERENCES crm_forms(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id integer REFERENCES crm_contacts(id) ON DELETE SET NULL,
  visitor_id integer REFERENCES crm_web_visitors(id) ON DELETE SET NULL,
  created_contact boolean DEFAULT false NOT NULL,
  email varchar(255) NOT NULL,
  answers jsonb DEFAULT '[]'::jsonb NOT NULL,
  page_url varchar(1000),
  ip_hash varchar(64),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_form_submissions_form_idx ON crm_form_submissions (form_id, created_at);
CREATE INDEX IF NOT EXISTS crm_form_submissions_contact_idx ON crm_form_submissions (contact_id, created_at);
CREATE INDEX IF NOT EXISTS crm_form_submissions_user_idx ON crm_form_submissions (user_id, created_at);
