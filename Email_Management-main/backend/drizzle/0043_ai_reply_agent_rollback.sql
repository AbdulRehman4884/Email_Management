-- Undo migration 0043 (AI reply agent). Deletes every AI draft and AI reply setting.
DROP TABLE IF EXISTS ai_reply_drafts;
DROP TABLE IF EXISTS ai_reply_settings;
