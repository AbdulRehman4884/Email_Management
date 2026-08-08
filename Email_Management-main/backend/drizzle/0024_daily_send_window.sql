ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_send_window_start varchar(8);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_send_window_end varchar(8);
