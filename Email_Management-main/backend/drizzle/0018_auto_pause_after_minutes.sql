-- Optional duration (minutes) after send start: pause_at is computed on start / worker activation
ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS auto_pause_after_minutes integer;
