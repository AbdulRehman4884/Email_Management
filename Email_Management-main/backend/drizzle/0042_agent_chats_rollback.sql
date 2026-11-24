-- Undo migration 0042: drops the AI Agent chat history table (every saved chat is deleted).
DROP INDEX IF EXISTS agent_chats_user_updated_idx;
DROP TABLE IF EXISTS agent_chats;
