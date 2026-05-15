-- Optional allowed ISO weekdays (1=Mon … 7=Sun) for sends; null = all days
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_weekdays jsonb;

ALTER TABLE follow_up_jobs ADD COLUMN IF NOT EXISTS send_weekdays jsonb;
