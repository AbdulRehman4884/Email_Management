ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "smtp_settings_id" integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_smtp_settings_id_smtp_settings_id_fk'
  ) THEN
    ALTER TABLE "campaigns"
      ADD CONSTRAINT "campaigns_smtp_settings_id_smtp_settings_id_fk"
      FOREIGN KEY ("smtp_settings_id") REFERENCES "public"."smtp_settings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $$;
