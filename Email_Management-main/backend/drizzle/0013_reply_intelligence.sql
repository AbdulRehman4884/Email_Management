CREATE TABLE IF NOT EXISTS "reply_intelligence" (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS "reply_intelligence_reply_idx"
  ON "reply_intelligence" ("reply_id");

CREATE UNIQUE INDEX IF NOT EXISTS "reply_intelligence_campaign_reply_idx"
  ON "reply_intelligence" ("campaign_id", "reply_id");
