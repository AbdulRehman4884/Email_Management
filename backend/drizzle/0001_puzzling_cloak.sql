CREATE TABLE "smtp_settings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "smtp_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"provider" varchar(50) NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer NOT NULL,
	"secure" boolean DEFAULT false NOT NULL,
	"user" varchar(255) NOT NULL,
	"password" varchar(500) NOT NULL,
	"from_email" varchar(255) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipients" ADD COLUMN "opened_at" timestamp;--> statement-breakpoint
ALTER TABLE "recipients" ADD COLUMN "replied_at" timestamp;--> statement-breakpoint
ALTER TABLE "campaign_stats" ADD COLUMN "opened_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_stats" ADD COLUMN "replied_count" integer DEFAULT 0 NOT NULL;