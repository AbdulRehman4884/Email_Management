-- Redefine SMTP daily limit: NULL = unlimited, 0 = block all sending, 1-50 = cap.
-- Previously 0 meant "unlimited"; preserve that intent for existing rows before the flip.
UPDATE smtp_settings SET daily_email_limit = NULL WHERE daily_email_limit = 0;

ALTER TABLE smtp_settings ALTER COLUMN daily_email_limit DROP NOT NULL;
ALTER TABLE smtp_settings ALTER COLUMN daily_email_limit DROP DEFAULT;
