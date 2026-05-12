-- Phase 1: AI Campaign — new tables and custom_fields column
ALTER TABLE "recipients" ADD COLUMN "custom_fields" text;
--> statement-breakpoint
CREATE TABLE "campaign_ai_prompts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaign_ai_prompts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"campaign_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"template_type" varchar(50),
	"tone_instruction" varchar(255),
	"custom_prompt" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_personalized_emails" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaign_personalized_emails_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"campaign_id" integer NOT NULL,
	"recipient_id" integer NOT NULL,
	"personalized_subject" varchar(500),
	"personalized_body" text NOT NULL,
	"generation_status" varchar(50) DEFAULT 'generated' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_ai_prompts" ADD CONSTRAINT "campaign_ai_prompts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "campaign_ai_prompts" ADD CONSTRAINT "campaign_ai_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "campaign_personalized_emails" ADD CONSTRAINT "campaign_personalized_emails_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "campaign_personalized_emails" ADD CONSTRAINT "campaign_personalized_emails_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE no action ON UPDATE no action;
