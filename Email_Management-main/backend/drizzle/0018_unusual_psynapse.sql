ALTER TABLE "campaigns" ALTER COLUMN "email_content" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "smtp_setting_ids" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "recipients" ADD COLUMN "used_smtp_email" varchar(255);