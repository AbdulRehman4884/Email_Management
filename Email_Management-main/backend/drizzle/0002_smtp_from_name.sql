ALTER TABLE "smtp_settings" ADD COLUMN IF NOT EXISTS "from_name" varchar(100) DEFAULT '' NOT NULL;
