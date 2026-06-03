CREATE TABLE IF NOT EXISTS bulk_import_jobs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id),
  file_name varchar(255) NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'queued',
  total_rows integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  duplicate_rows integer NOT NULL DEFAULT 0,
  invalid_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  batch_size integer NOT NULL DEFAULT 50,
  campaign_id integer REFERENCES campaigns(id) ON DELETE SET NULL,
  validation_summary jsonb,
  template_selection jsonb,
  template_configured_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bulk_import_rows (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  job_id integer NOT NULL REFERENCES bulk_import_jobs(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  name varchar(255),
  company varchar(255),
  website varchar(500),
  email varchar(255),
  role varchar(255),
  industry varchar(255),
  status varchar(40) NOT NULL DEFAULT 'queued',
  error varchar(2000),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bulk_import_rows_job_row_idx
  ON bulk_import_rows(job_id, row_number);

CREATE TABLE IF NOT EXISTS generated_templates (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  row_id integer NOT NULL REFERENCES bulk_import_rows(id) ON DELETE CASCADE,
  job_id integer REFERENCES bulk_import_jobs(id) ON DELETE CASCADE,
  selected_template_id varchar(80),
  template_name varchar(120),
  selected_tone varchar(120),
  selected_cta_style varchar(120),
  subject varchar(500) NOT NULL,
  body text NOT NULL,
  followup1 text NOT NULL,
  followup2 text NOT NULL,
  cta varchar(500) NOT NULL,
  rationale text,
  confidence real NOT NULL DEFAULT 0.5,
  persona varchar(255) NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'pending_review',
  user_edited_subject text,
  user_edited_body text,
  user_edited_followup1 text,
  user_edited_followup2 text,
  missing_data_warnings jsonb,
  approved_at timestamp,
  generated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE bulk_import_jobs ADD COLUMN IF NOT EXISTS template_selection jsonb;
ALTER TABLE bulk_import_jobs ADD COLUMN IF NOT EXISTS template_configured_at timestamp;
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS job_id integer REFERENCES bulk_import_jobs(id) ON DELETE CASCADE;
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS selected_template_id varchar(80);
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS template_name varchar(120);
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS selected_tone varchar(120);
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS selected_cta_style varchar(120);
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS user_edited_subject text;
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS user_edited_body text;
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS user_edited_followup1 text;
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS user_edited_followup2 text;
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS missing_data_warnings jsonb;
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS approved_at timestamp;
ALTER TABLE generated_templates ADD COLUMN IF NOT EXISTS generated_at timestamp NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS generated_templates_row_idx
  ON generated_templates(row_id);
