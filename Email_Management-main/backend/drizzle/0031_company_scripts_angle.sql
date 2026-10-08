-- Script generation: where the script's problem comes from — "website" or "industry" (best guess).
-- Idempotent — safe to run more than once.
ALTER TABLE "company_scripts" ADD COLUMN IF NOT EXISTS "angle" varchar(20) NOT NULL DEFAULT 'website';
