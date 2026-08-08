-- Run against existing PostgreSQL databases after pulling schema with campaigns.updated_at.
-- New installs created via Drizzle push/generate already include this column.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

-- Backfill so historical rows sort by original creation date (ALTER may set the same NOW() on all rows).
UPDATE campaigns SET updated_at = created_at::timestamp;
