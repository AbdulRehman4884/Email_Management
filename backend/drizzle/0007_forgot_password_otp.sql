ALTER TABLE "users" ADD COLUMN "password_reset_otp_hash" varchar(255);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_reset_otp_expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_reset_otp_used_at" timestamp;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_reset_requested_at" timestamp;
