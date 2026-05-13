CREATE TABLE IF NOT EXISTS follow_up_jobs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id integer NOT NULL REFERENCES users(id),
  campaign_id integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scheduled_at varchar(30) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  template_id varchar(64) NOT NULL,
  prior_follow_up_count integer NOT NULL DEFAULT 0,
  engagement varchar(20) NOT NULL DEFAULT 'sent',
  paused_campaign_was_running boolean NOT NULL DEFAULT false,
  error_message varchar(2000),
  started_at timestamp,
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_follow_up_jobs_user_status ON follow_up_jobs (user_id, status);
CREATE INDEX IF NOT EXISTS idx_follow_up_jobs_campaign ON follow_up_jobs (campaign_id);

ALTER TABLE email_replies ADD COLUMN IF NOT EXISTS follow_up_template_id varchar(64);
