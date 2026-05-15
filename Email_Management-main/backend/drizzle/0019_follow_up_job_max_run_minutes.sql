-- Optional cap: job stops after this many minutes from when it starts running (same idea as campaign send window)
ALTER TABLE follow_up_jobs ADD COLUMN IF NOT EXISTS max_run_minutes integer;
