-- Migration 0042: AI Agent chat history (bug A-17: chats lived only in the browser's localStorage —
-- no list of earlier chats, and another browser or device on the same account showed an empty chat).
-- ADDITIVE ONLY: one new table, no existing table is changed. Safe to run more than once.
-- Undo: drizzle/0042_agent_chats_rollback.sql
--
-- One row per chat. session_id is the AI agent's session id (the chat's id in the agent service).
-- messages: the chat as the web page shows it (role, content, timestamp, structured result), newest last.

CREATE TABLE IF NOT EXISTS agent_chats (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id varchar(100) NOT NULL,
  title varchar(120) DEFAULT 'New chat' NOT NULL,
  messages jsonb DEFAULT '[]'::jsonb NOT NULL,
  message_count integer DEFAULT 0 NOT NULL,
  active_campaign_id varchar(50),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT agent_chats_user_session_uq UNIQUE (user_id, session_id)
);
CREATE INDEX IF NOT EXISTS agent_chats_user_updated_idx ON agent_chats (user_id, updated_at DESC);
