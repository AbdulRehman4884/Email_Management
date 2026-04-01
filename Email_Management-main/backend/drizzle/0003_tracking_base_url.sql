ALTER TABLE "smtp_settings" ADD COLUMN IF NOT EXISTS "tracking_base_url" varchar(500);
