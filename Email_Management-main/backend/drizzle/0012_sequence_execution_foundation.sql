CREATE TABLE IF NOT EXISTS "recipient_sequence_state" (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS "recipient_sequence_state_campaign_recipient_idx"
  ON "recipient_sequence_state" ("campaign_id", "recipient_id");

ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "execution_status" varchar(50) NOT NULL DEFAULT 'pending';
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "scheduled_for_at" timestamp;
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "sent_at" timestamp;
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "message_id" varchar(500);
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp;
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "retry_after_at" timestamp;
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "last_error" varchar(2000);
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "skipped_at" timestamp;
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "skip_reason" varchar(80);
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "bounced_at" timestamp;
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "replied_at" timestamp;
ALTER TABLE "campaign_sequence_touches"
  ADD COLUMN IF NOT EXISTS "unsubscribed_at" timestamp;

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_sequence_touches_campaign_recipient_touch_idx"
  ON "campaign_sequence_touches" ("campaign_id", "recipient_id", "touch_number");
