ALTER TABLE email_replies ADD COLUMN IF NOT EXISTS follow_up_job_id integer REFERENCES follow_up_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_email_replies_follow_up_job ON email_replies (follow_up_job_id);
CREATE INDEX IF NOT EXISTS idx_email_replies_campaign_follow_up_job ON email_replies (campaign_id, follow_up_job_id);
