-- Per-SMTP daily email limit, campaign daily cap & pause reason, send ledger, notifications

ALTER TABLE "smtp_settings" ADD COLUMN "daily_email_limit" integer NOT NULL DEFAULT 50;

ALTER TABLE "campaigns" ADD COLUMN "daily_send_limit" integer;
ALTER TABLE "campaigns" ADD COLUMN "pause_reason" varchar(50);
ALTER TABLE "campaigns" ADD COLUMN "paused_at" timestamptz;

CREATE TABLE "email_send_log" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "smtp_settings_id" integer NOT NULL REFERENCES "smtp_settings"("id"),
  "campaign_id" integer NOT NULL REFERENCES "campaigns"("id"),
  "sent_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "email_send_log_user_smtp_sent_idx" ON "email_send_log" ("user_id", "smtp_settings_id", "sent_at");
CREATE INDEX "email_send_log_campaign_sent_idx" ON "email_send_log" ("campaign_id", "sent_at");

CREATE TABLE "user_notifications" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "type" varchar(50) NOT NULL,
  "payload" jsonb,
  "read_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "user_notifications_user_unread_idx" ON "user_notifications" ("user_id", "read_at");
