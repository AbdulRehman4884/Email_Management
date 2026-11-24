-- Undo migration 0044. Deletes every Library file; chats keep their messages (pins and custom names are lost).
DROP TABLE IF EXISTS agent_library_files;
DROP INDEX IF EXISTS agent_chats_user_pinned_idx;
ALTER TABLE agent_chats DROP COLUMN IF EXISTS title_custom;
ALTER TABLE agent_chats DROP COLUMN IF EXISTS unpinned_at;
ALTER TABLE agent_chats DROP COLUMN IF EXISTS pinned_at;
