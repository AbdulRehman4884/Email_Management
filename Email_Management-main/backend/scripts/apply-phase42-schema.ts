import "dotenv/config";
import { Client } from "pg";

const statements = [
  `CREATE TABLE IF NOT EXISTS "recipient_sequence_state" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "campaign_id" integer NOT NULL REFERENCES "campaigns"("id"),
    "recipient_id" integer NOT NULL REFERENCES "recipients"("id"),
    "current_touch_number" integer NOT NULL DEFAULT 0,
    "next_touch_number" integer NOT NULL DEFAULT 1,
    "next_scheduled_touch_at" timestamp,
    "sequence_status" varchar(50) NOT NULL DEFAULT 'pending',
    "sequence_started_at" timestamp,
    "sequence_completed_at" timestamp,
    "last_touch_sent_at" timestamp,
    "last_reply_at" timestamp,
    "last_bounce_at" timestamp,
    "unsubscribed_at" timestamp,
    "stop_reason" varchar(80),
    "sequence_paused" boolean NOT NULL DEFAULT false,
    "retry_count" integer NOT NULL DEFAULT 0,
    "last_touch_message_id" varchar(500),
    "last_attempted_touch_number" integer,
    "last_error" varchar(2000),
    "created_at" timestamp NOT NULL DEFAULT now(),
    "updated_at" timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "recipient_sequence_state_campaign_recipient_idx"
    ON "recipient_sequence_state" ("campaign_id", "recipient_id")`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "execution_status" varchar(50) NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "scheduled_for_at" timestamp`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "sent_at" timestamp`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "message_id" varchar(500)`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "retry_after_at" timestamp`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "last_error" varchar(2000)`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "skipped_at" timestamp`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "skip_reason" varchar(80)`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "bounced_at" timestamp`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "replied_at" timestamp`,
  `ALTER TABLE "campaign_sequence_touches" ADD COLUMN IF NOT EXISTS "unsubscribed_at" timestamp`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "campaign_sequence_touches_campaign_recipient_touch_idx"
    ON "campaign_sequence_touches" ("campaign_id", "recipient_id", "touch_number")`,
  `CREATE TABLE IF NOT EXISTS "reply_intelligence" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "reply_id" integer NOT NULL REFERENCES "email_replies"("id"),
    "campaign_id" integer NOT NULL REFERENCES "campaigns"("id"),
    "recipient_id" integer NOT NULL REFERENCES "recipients"("id"),
    "intent_category" varchar(80) NOT NULL,
    "intent_confidence" real NOT NULL DEFAULT 0,
    "sentiment" varchar(30) NOT NULL DEFAULT 'neutral',
    "buying_signal_strength" integer NOT NULL DEFAULT 0,
    "urgency_level" varchar(20) NOT NULL DEFAULT 'low',
    "meeting_likelihood" integer NOT NULL DEFAULT 0,
    "objection_type" varchar(50),
    "meeting_ready" boolean NOT NULL DEFAULT false,
    "lead_temperature" varchar(20) NOT NULL DEFAULT 'cold',
    "hot_lead_score" integer NOT NULL DEFAULT 0,
    "requires_human_review" boolean NOT NULL DEFAULT false,
    "review_status" varchar(30) NOT NULL DEFAULT 'pending',
    "review_reason" varchar(1000),
    "auto_reply_mode" varchar(30) NOT NULL DEFAULT 'suggest_only',
    "detected_language" varchar(20) NOT NULL DEFAULT 'en',
    "reply_summary" varchar(1000),
    "suggested_reply_text" text,
    "suggested_reply_html" text,
    "suggestion_diagnostics" text,
    "reasoning" text,
    "response_time_minutes" integer,
    "prior_reply_count" integer NOT NULL DEFAULT 0,
    "is_high_value_lead" boolean NOT NULL DEFAULT false,
    "created_at" timestamp NOT NULL DEFAULT now(),
    "updated_at" timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "reply_intelligence_reply_idx"
    ON "reply_intelligence" ("reply_id")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "reply_intelligence_campaign_reply_idx"
    ON "reply_intelligence" ("campaign_id", "reply_id")`,
];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    console.log("Applied Phase 4.2 schema successfully");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Failed to apply Phase 4.2 schema", error);
  process.exitCode = 1;
});
