CREATE TABLE "campaign_sequence_touches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaign_sequence_touches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"campaign_id" integer NOT NULL,
	"recipient_id" integer NOT NULL,
	"touch_number" integer NOT NULL,
	"sequence_type" varchar(80) NOT NULL,
	"objective" varchar(120) NOT NULL,
	"recommended_delay_days" integer DEFAULT 0 NOT NULL,
	"tone_used" varchar(80),
	"cta_type" varchar(80),
	"cta_text" varchar(500),
	"personalized_subject" varchar(500),
	"personalized_body" text NOT NULL,
	"personalized_text" text,
	"previous_touch_summary" text,
	"deliverability_risk" varchar(20),
	"strategy_reasoning" text,
	"generation_status" varchar(50) DEFAULT 'generated' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_personalized_emails" ADD COLUMN "tone_used" varchar(80);--> statement-breakpoint
ALTER TABLE "campaign_personalized_emails" ADD COLUMN "cta_type" varchar(80);--> statement-breakpoint
ALTER TABLE "campaign_personalized_emails" ADD COLUMN "cta_text" varchar(500);--> statement-breakpoint
ALTER TABLE "campaign_personalized_emails" ADD COLUMN "sequence_type" varchar(80);--> statement-breakpoint
ALTER TABLE "campaign_personalized_emails" ADD COLUMN "touch_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_personalized_emails" ADD COLUMN "deliverability_risk" varchar(20);--> statement-breakpoint
ALTER TABLE "campaign_personalized_emails" ADD COLUMN "strategy_reasoning" text;--> statement-breakpoint
ALTER TABLE "campaign_sequence_touches" ADD CONSTRAINT "campaign_sequence_touches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sequence_touches" ADD CONSTRAINT "campaign_sequence_touches_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE no action ON UPDATE no action;