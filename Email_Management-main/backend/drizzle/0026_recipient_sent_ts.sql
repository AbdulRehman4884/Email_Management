-- Internal precise send timestamp used ONLY by open tracking to ignore the automatic
-- provider/scanner pixel fetch that happens the instant an email is sent. The visible
-- `sent_at` (date) is left unchanged. Real opens (any time later) are unaffected.
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS sent_ts timestamptz;
