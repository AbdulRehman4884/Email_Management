CREATE TABLE "campaigns" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaigns_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(255) NOT NULL,
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"subject" varchar(255) NOT NULL,
	"email_content" varchar(5000) NOT NULL,
	"from_name" varchar(100) NOT NULL,
	"from_email" varchar(100) NOT NULL,
	"reciept_count" integer DEFAULT 0 NOT NULL,
	"created_at" date DEFAULT now() NOT NULL,
	"scheduled_at" date
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipients_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"campaign_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"name" varchar(100),
	"message_id" varchar(255),
	"sent_at" date,
	"delivered_at" date
);
--> statement-breakpoint
CREATE TABLE "campaign_stats" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaign_stats_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"campaign_id" integer NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"bounced_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"complained_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "suppression_list_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" varchar(255) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"added_at" date DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_list_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_stats" ADD CONSTRAINT "campaign_stats_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;