-- Add optional pause_at column to campaigns for scheduled auto-pause
ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS pause_at varchar(30);
