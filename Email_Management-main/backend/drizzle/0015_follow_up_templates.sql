ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "follow_up_templates" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "follow_up_skip_confirm" boolean DEFAULT false NOT NULL;
