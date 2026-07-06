-- Tracks when the SMTP daily limit was last changed from null/0 (unlimited) to a
-- positive value. countSendsTodayForSmtp uses this as a lower bound so sends made
-- under the old "unlimited" setting don't count against the newly configured quota.
ALTER TABLE smtp_settings ADD COLUMN IF NOT EXISTS daily_limit_reset_at TIMESTAMP WITH TIME ZONE;
