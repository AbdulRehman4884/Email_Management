-- Threading for inbox: outbound rows + stable thread root per conversation
ALTER TABLE email_replies
  ADD COLUMN IF NOT EXISTS direction varchar(20) NOT NULL DEFAULT 'inbound',
  ADD COLUMN IF NOT EXISTS thread_root_id integer REFERENCES email_replies(id);

-- Legacy rows: each existing message is its own thread root
UPDATE email_replies SET thread_root_id = id WHERE thread_root_id IS NULL;
