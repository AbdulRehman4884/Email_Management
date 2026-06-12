ALTER TABLE email_replies
ADD COLUMN IF NOT EXISTS read_at timestamp;
