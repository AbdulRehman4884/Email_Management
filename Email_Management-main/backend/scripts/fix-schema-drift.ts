/**
 * scripts/fix-schema-drift.ts
 *
 * Idempotent schema-drift repair script.
 *
 * Run with:
 *   bun scripts/fix-schema-drift.ts
 *   # or
 *   npx tsx scripts/fix-schema-drift.ts
 *
 * Safe to re-run — every statement uses IF NOT EXISTS / DO-block guards.
 * Does NOT drop, truncate, or rename anything.
 * Does NOT reset sequences or remove data.
 *
 * Root cause this fixes:
 *   The application code (Drizzle schema) advanced ahead of the database schema.
 *   Several migration files exist but were never applied to the production DB,
 *   and some columns/tables defined in schema.ts have no migration file at all.
 *   This script brings the database in line with the current schema.ts snapshot.
 */

import "dotenv/config";
import { Client } from "pg";

// ── Helpers ──────────────────────────────────────────────────────────────────

type Step = { label: string; sql: string };

function col(table: string, column: string, ddl: string): Step {
  return {
    label: `ADD COLUMN ${table}.${column}`,
    sql: `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${ddl}`,
  };
}

function createTable(name: string, ddl: string): Step {
  return { label: `CREATE TABLE ${name}`, sql: ddl };
}

function createIndex(name: string, ddl: string): Step {
  return { label: `CREATE INDEX ${name}`, sql: ddl };
}

function raw(label: string, sql: string): Step {
  return { label, sql };
}

// ── Migration steps ───────────────────────────────────────────────────────────
// Every step is idempotent. Order matters: tables before their dependents.

const steps: Step[] = [
  // ── users ────────────────────────────────────────────────────────────────
  col("users", "preferred_theme",           "varchar(20) NOT NULL DEFAULT 'dark'"),
  col("users", "password_reset_otp_hash",    "varchar(255)"),
  col("users", "password_reset_otp_expires_at", "timestamp"),
  col("users", "password_reset_otp_used_at",    "timestamp"),
  col("users", "password_reset_requested_at",   "timestamp"),

  // ── smtp_settings ─────────────────────────────────────────────────────────
  col("smtp_settings", "daily_email_limit", "integer NOT NULL DEFAULT 50"),

  // ── campaigns ─────────────────────────────────────────────────────────────
  col("campaigns", "smtp_settings_id",        "integer"),
  col("campaigns", "pause_at",                "varchar(30)"),
  col("campaigns", "auto_pause_after_minutes","integer"),
  col("campaigns", "available_columns",       "varchar(2000)"),
  col("campaigns", "follow_up_templates",     "jsonb NOT NULL DEFAULT '[]'::jsonb"),
  col("campaigns", "follow_up_skip_confirm",  "boolean NOT NULL DEFAULT false"),
  col("campaigns", "daily_send_limit",        "integer"),
  col("campaigns", "send_weekdays",           "jsonb"),
  col("campaigns", "pause_reason",            "varchar(50)"),
  col("campaigns", "paused_at",              "timestamp"),

  // ── recipients ───────────────────────────────────────────────────────────
  col("recipients", "custom_fields",   "text"),
  col("recipients", "last_send_error", "varchar(2000)"),

  // ── email_send_log (may not exist at all) ────────────────────────────────
  createTable("email_send_log", `
    CREATE TABLE IF NOT EXISTS "email_send_log" (
      "id"               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "user_id"          integer NOT NULL REFERENCES "users"("id"),
      "smtp_settings_id" integer NOT NULL REFERENCES "smtp_settings"("id"),
      "campaign_id"      integer NOT NULL REFERENCES "campaigns"("id"),
      "sent_at"          timestamp WITH TIME ZONE NOT NULL DEFAULT now()
    )
  `),

  createIndex("email_send_log_user_smtp_sent_idx", `
    CREATE INDEX IF NOT EXISTS "email_send_log_user_smtp_sent_idx"
      ON "email_send_log" ("user_id", "smtp_settings_id", "sent_at")
  `),
  createIndex("email_send_log_campaign_sent_idx", `
    CREATE INDEX IF NOT EXISTS "email_send_log_campaign_sent_idx"
      ON "email_send_log" ("campaign_id", "sent_at")
  `),

  // ── follow_up_jobs ────────────────────────────────────────────────────────
  // Full schema.ts definition including max_run_minutes and send_weekdays
  // (columns added in later migrations that share the same drift issue).
  createTable("follow_up_jobs", `
    CREATE TABLE IF NOT EXISTS "follow_up_jobs" (
      "id"                         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "user_id"                    integer NOT NULL REFERENCES "users"("id"),
      "campaign_id"                integer NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
      "scheduled_at"               varchar(30) NOT NULL,
      "status"                     varchar(20) NOT NULL DEFAULT 'pending',
      "template_id"                varchar(64) NOT NULL,
      "prior_follow_up_count"      integer NOT NULL DEFAULT 0,
      "engagement"                 varchar(20) NOT NULL DEFAULT 'sent',
      "max_run_minutes"            integer,
      "send_weekdays"              jsonb,
      "paused_campaign_was_running" boolean NOT NULL DEFAULT false,
      "error_message"              varchar(2000),
      "started_at"                 timestamp,
      "completed_at"               timestamp,
      "created_at"                 timestamp NOT NULL DEFAULT now()
    )
  `),

  createIndex("idx_follow_up_jobs_user_status", `
    CREATE INDEX IF NOT EXISTS "idx_follow_up_jobs_user_status"
      ON "follow_up_jobs" ("user_id", "status")
  `),
  createIndex("idx_follow_up_jobs_campaign", `
    CREATE INDEX IF NOT EXISTS "idx_follow_up_jobs_campaign"
      ON "follow_up_jobs" ("campaign_id")
  `),

  // ── email_replies.follow_up_template_id (same migration as follow_up_jobs) ─
  col("email_replies", "follow_up_template_id", "varchar(64)"),

  // ── user_notifications ────────────────────────────────────────────────────
  createTable("user_notifications", `
    CREATE TABLE IF NOT EXISTS "user_notifications" (
      "id"         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "user_id"    integer NOT NULL REFERENCES "users"("id"),
      "type"       varchar(50) NOT NULL,
      "payload"    jsonb,
      "read_at"    timestamp,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `),

  createIndex("idx_user_notifications_user_id", `
    CREATE INDEX IF NOT EXISTS "idx_user_notifications_user_id"
      ON "user_notifications" ("user_id")
  `),

  // ── campaign_sequence_touches (execution columns added later) ─────────────
  col("campaign_sequence_touches", "execution_status", "varchar(50) NOT NULL DEFAULT 'pending'"),
  col("campaign_sequence_touches", "scheduled_for_at", "timestamp"),
  col("campaign_sequence_touches", "sent_at",          "timestamp"),
  col("campaign_sequence_touches", "message_id",       "varchar(500)"),
  col("campaign_sequence_touches", "attempt_count",    "integer NOT NULL DEFAULT 0"),
  col("campaign_sequence_touches", "last_attempt_at",  "timestamp"),
  col("campaign_sequence_touches", "retry_after_at",   "timestamp"),
  col("campaign_sequence_touches", "last_error",       "varchar(2000)"),
  col("campaign_sequence_touches", "skipped_at",       "timestamp"),
  col("campaign_sequence_touches", "skip_reason",      "varchar(80)"),
  col("campaign_sequence_touches", "bounced_at",       "timestamp"),
  col("campaign_sequence_touches", "replied_at",       "timestamp"),
  col("campaign_sequence_touches", "unsubscribed_at",  "timestamp"),

  createIndex("campaign_sequence_touches_campaign_recipient_touch_idx", `
    CREATE UNIQUE INDEX IF NOT EXISTS "campaign_sequence_touches_campaign_recipient_touch_idx"
      ON "campaign_sequence_touches" ("campaign_id", "recipient_id", "touch_number")
  `),

  // ── recipient_sequence_state (may not exist at all) ───────────────────────
  createTable("recipient_sequence_state", `
    CREATE TABLE IF NOT EXISTS "recipient_sequence_state" (
      "id"                          integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "campaign_id"                 integer NOT NULL REFERENCES "campaigns"("id"),
      "recipient_id"                integer NOT NULL REFERENCES "recipients"("id"),
      "current_touch_number"        integer NOT NULL DEFAULT 0,
      "next_touch_number"           integer NOT NULL DEFAULT 1,
      "next_scheduled_touch_at"     timestamp,
      "sequence_status"             varchar(50) NOT NULL DEFAULT 'pending',
      "sequence_started_at"         timestamp,
      "sequence_completed_at"       timestamp,
      "last_touch_sent_at"          timestamp,
      "last_reply_at"               timestamp,
      "last_bounce_at"              timestamp,
      "unsubscribed_at"             timestamp,
      "stop_reason"                 varchar(80),
      "sequence_paused"             boolean NOT NULL DEFAULT false,
      "retry_count"                 integer NOT NULL DEFAULT 0,
      "last_touch_message_id"       varchar(500),
      "last_attempted_touch_number" integer,
      "last_error"                  varchar(2000),
      "created_at"                  timestamp NOT NULL DEFAULT now(),
      "updated_at"                  timestamp NOT NULL DEFAULT now()
    )
  `),

  createIndex("recipient_sequence_state_campaign_recipient_idx", `
    CREATE UNIQUE INDEX IF NOT EXISTS "recipient_sequence_state_campaign_recipient_idx"
      ON "recipient_sequence_state" ("campaign_id", "recipient_id")
  `),

  // ── campaign_personalized_emails (later columns) ──────────────────────────
  col("campaign_personalized_emails", "tone_used",            "varchar(80)"),
  col("campaign_personalized_emails", "cta_type",             "varchar(80)"),
  col("campaign_personalized_emails", "cta_text",             "varchar(500)"),
  col("campaign_personalized_emails", "sequence_type",        "varchar(80)"),
  col("campaign_personalized_emails", "touch_number",         "integer NOT NULL DEFAULT 1"),
  col("campaign_personalized_emails", "deliverability_risk",  "varchar(20)"),
  col("campaign_personalized_emails", "strategy_reasoning",   "text"),

  // ── reply_intelligence (may not exist at all) ─────────────────────────────
  createTable("reply_intelligence", `
    CREATE TABLE IF NOT EXISTS "reply_intelligence" (
      "id"                   integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "reply_id"             integer NOT NULL REFERENCES "email_replies"("id"),
      "campaign_id"          integer NOT NULL REFERENCES "campaigns"("id"),
      "recipient_id"         integer NOT NULL REFERENCES "recipients"("id"),
      "intent_category"      varchar(80) NOT NULL,
      "intent_confidence"    real NOT NULL DEFAULT 0,
      "sentiment"            varchar(30) NOT NULL DEFAULT 'neutral',
      "buying_signal_strength" integer NOT NULL DEFAULT 0,
      "urgency_level"        varchar(20) NOT NULL DEFAULT 'low',
      "meeting_likelihood"   integer NOT NULL DEFAULT 0,
      "objection_type"       varchar(50),
      "meeting_ready"        boolean NOT NULL DEFAULT false,
      "lead_temperature"     varchar(20) NOT NULL DEFAULT 'cold',
      "hot_lead_score"       integer NOT NULL DEFAULT 0,
      "requires_human_review" boolean NOT NULL DEFAULT false,
      "review_status"        varchar(30) NOT NULL DEFAULT 'pending',
      "review_reason"        varchar(1000),
      "auto_reply_mode"      varchar(30) NOT NULL DEFAULT 'suggest_only',
      "detected_language"    varchar(20) NOT NULL DEFAULT 'en',
      "reply_summary"        varchar(1000),
      "suggested_reply_text" text,
      "suggested_reply_html" text,
      "suggestion_diagnostics" text,
      "reasoning"            text,
      "response_time_minutes" integer,
      "prior_reply_count"    integer NOT NULL DEFAULT 0,
      "is_high_value_lead"   boolean NOT NULL DEFAULT false,
      "created_at"           timestamp NOT NULL DEFAULT now(),
      "updated_at"           timestamp NOT NULL DEFAULT now()
    )
  `),

  createIndex("reply_intelligence_reply_idx", `
    CREATE UNIQUE INDEX IF NOT EXISTS "reply_intelligence_reply_idx"
      ON "reply_intelligence" ("reply_id")
  `),
  createIndex("reply_intelligence_campaign_reply_idx", `
    CREATE UNIQUE INDEX IF NOT EXISTS "reply_intelligence_campaign_reply_idx"
      ON "reply_intelligence" ("campaign_id", "reply_id")
  `),

  // ── Indexes for the columns we just added ─────────────────────────────────
  createIndex("idx_campaigns_smtp_settings_id", `
    CREATE INDEX IF NOT EXISTS "idx_campaigns_smtp_settings_id"
      ON "campaigns" ("smtp_settings_id")
  `),

  // ── FK: campaigns.smtp_settings_id → smtp_settings.id ────────────────────
  // Guard with a DO block so it's idempotent even on re-run.
  raw("FK campaigns.smtp_settings_id → smtp_settings.id", `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_smtp_settings_id_smtp_settings_id_fk'
          AND conrelid = 'campaigns'::regclass
      ) THEN
        ALTER TABLE "campaigns"
          ADD CONSTRAINT "campaigns_smtp_settings_id_smtp_settings_id_fk"
          FOREIGN KEY ("smtp_settings_id")
          REFERENCES "smtp_settings"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION;
      END IF;
    END $$
  `),
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const connUrl = process.env.DATABASE_URL;
  if (!connUrl) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: connUrl });
  await client.connect();
  console.log("Connected to database.");

  let applied = 0;
  let skipped = 0;
  let failed  = 0;

  for (const step of steps) {
    try {
      await client.query(step.sql);
      console.log(`  ✓  ${step.label}`);
      applied++;
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      // 42701 = column already exists, 42P07 = relation already exists,
      // 42710 = duplicate constraint — all harmless when IF NOT EXISTS is used
      // but DO-block guards don't surface 42710 as a PG error.
      if (["42701", "42P07", "42710"].includes(pgErr.code ?? "")) {
        console.log(`  –  ${step.label} (already exists, skipped)`);
        skipped++;
      } else {
        console.error(`  ✗  ${step.label}`);
        console.error(`     ${pgErr.code}: ${pgErr.message}`);
        failed++;
      }
    }
  }

  await client.end();

  console.log("");
  console.log(`Schema drift fix complete: ${applied} applied, ${skipped} already present, ${failed} failed.`);

  if (failed > 0) {
    console.error(`${failed} step(s) failed — review errors above.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
