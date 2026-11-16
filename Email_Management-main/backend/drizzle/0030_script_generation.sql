-- Script generation: uploaded company lists + saved scripts (cold email / cold call / LinkedIn).
-- Idempotent — safe to run more than once.

CREATE TABLE IF NOT EXISTS "script_files" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "filename" varchar(255) NOT NULL,
  "user_instructions" text,
  "total_rows" integer NOT NULL,
  "company_count" integer NOT NULL,
  "report" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "script_files_user_idx" ON "script_files" ("user_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "script_companies" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "file_id" integer NOT NULL REFERENCES "script_files"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "row_number" integer NOT NULL,
  "company_name" varchar(255) NOT NULL,
  "website" varchar(500) NOT NULL,
  "extra_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "website_content" text,
  "website_fetched_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "script_companies_file_idx" ON "script_companies" ("file_id", "row_number");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_scripts" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "company_id" integer NOT NULL REFERENCES "script_companies"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "type" varchar(20) NOT NULL,
  "status" varchar(30) NOT NULL,
  "what_they_sell" text NOT NULL DEFAULT '',
  "problem_statement" text NOT NULL DEFAULT '',
  "pain_points" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "recommended_services" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "subject" varchar(255),
  "script" text NOT NULL DEFAULT '',
  "word_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_scripts_company_type_uq" ON "company_scripts" ("company_id", "type");
