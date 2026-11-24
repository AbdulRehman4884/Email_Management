-- Migration 0044: AI Agent chats — pin, rename, search; Library of uploaded files.
-- Run after 0042_agent_chats.sql. ADDITIVE ONLY: three new columns on agent_chats and one new table.
-- Safe to run more than once. Undo: drizzle/0044_agent_chat_pins_library_rollback.sql
--
-- Retention (controllers/agentChatController.ts): a chat is deleted 30 days after its last message; a pinned chat is
-- never deleted; when it is unpinned its 30 days start again from the unpin time (unpinned_at).

ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS pinned_at timestamp with time zone;
ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS unpinned_at timestamp with time zone;
-- true once the user renamed the chat: saving new messages no longer changes the title.
ALTER TABLE agent_chats ADD COLUMN IF NOT EXISTS title_custom boolean DEFAULT false NOT NULL;
CREATE INDEX IF NOT EXISTS agent_chats_user_pinned_idx ON agent_chats (user_id) WHERE pinned_at IS NOT NULL;

-- Files the user attached in the AI Agent chat (CSV / Excel). At most 150 MB per user: the oldest go first.
CREATE TABLE IF NOT EXISTS agent_library_files (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The chat the file was attached in (the chat may be deleted later; the file stays).
  session_id varchar(100),
  file_name varchar(255) NOT NULL,
  mime_type varchar(100) NOT NULL,
  size_bytes integer NOT NULL,
  content bytea NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_library_files_user_idx ON agent_library_files (user_id, created_at DESC);
